import type { Metadata } from "next";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "API Reference",
  description:
    "Complete REST API reference for the Optio server. Endpoints for tasks, repos, secrets, logs, analytics, and WebSocket streaming.",
};

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-emerald-500/10 text-emerald-400",
    POST: "bg-blue-500/10 text-blue-400",
    PUT: "bg-amber-500/10 text-amber-400",
    PATCH: "bg-orange-500/10 text-orange-400",
    DELETE: "bg-red-500/10 text-red-400",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-bold font-mono ${colors[method] || ""}`}
    >
      {method}
    </span>
  );
}

interface Route {
  method: string;
  path: string;
  description: string;
}

function RouteTable({ routes }: { routes: Route[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border bg-bg-subtle">
            <th className="px-4 py-3 text-left font-semibold text-text-heading w-20">Method</th>
            <th className="px-4 py-3 text-left font-semibold text-text-heading">Endpoint</th>
            <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {routes.map((route) => (
            <tr key={`${route.method}-${route.path}`}>
              <td className="px-4 py-3">
                <MethodBadge method={route.method} />
              </td>
              <td className="px-4 py-3 font-mono text-text-heading">{route.path}</td>
              <td className="px-4 py-3 text-text-muted">{route.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ApiReferencePage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">API Reference</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        The Optio API is a REST API served by Fastify. All endpoints are prefixed with{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">/api</code> and
        return JSON. Request bodies use JSON with Zod schema validation.
      </p>

      <Callout type="info">
        All endpoints except{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">/api/health</code>
        ,{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">/api/auth/*</code>
        , and{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          /api/setup/*
        </code>{" "}
        require authentication via the{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          optio_session
        </code>{" "}
        cookie or a{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">?token=</code>{" "}
        query parameter.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Health</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/health",
            description: "Health check endpoint (no auth required)",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Tasks</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Tasks are the core resource. The <code>/api/tasks</code> endpoint is polymorphic over three
        kinds, distinguished by a <code>type</code> field:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong>repo-task</strong> — an ad-hoc Repo Task (agent clones repo, opens PR).
        </li>
        <li>
          <strong>repo-blueprint</strong> — a scheduled Repo Task config; triggers spawn fresh runs.
        </li>
        <li>
          <strong>standalone</strong> — a Standalone Task (agent runs with no repo).
        </li>
      </ul>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/tasks?type=...",
            description:
              "List tasks (type=repo-task|repo-blueprint|standalone|all; default repo-task)",
          },
          {
            method: "POST",
            path: "/api/tasks",
            description: "Create a task (body.type discriminates the kind)",
          },
          {
            method: "GET",
            path: "/api/tasks/:id",
            description: "Get any task by id; response includes a type discriminator",
          },
          { method: "PATCH", path: "/api/tasks/:id", description: "Update a task" },
          { method: "DELETE", path: "/api/tasks/:id", description: "Delete a task" },
          {
            method: "GET",
            path: "/api/tasks/:id/runs",
            description: "List runs under a blueprint or standalone Task",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/runs",
            description: "Kick off a run (for blueprints/standalone)",
          },
          {
            method: "GET",
            path: "/api/tasks/:id/runs/:runId",
            description: "Get a single run",
          },
          {
            method: "GET",
            path: "/api/tasks/:id/triggers",
            description: "List triggers on a blueprint or standalone Task",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/triggers",
            description: "Attach a trigger (schedule/webhook/ticket/manual)",
          },
          {
            method: "PATCH",
            path: "/api/tasks/:id/triggers/:triggerId",
            description: "Update a trigger",
          },
          {
            method: "DELETE",
            path: "/api/tasks/:id/triggers/:triggerId",
            description: "Delete a trigger",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/cancel",
            description: "Cancel a running or queued task",
          },
          { method: "POST", path: "/api/tasks/:id/retry", description: "Retry a failed task" },
          {
            method: "POST",
            path: "/api/tasks/:id/resume",
            description: "Resume a needs_attention or failed task with new context",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/force-restart",
            description: "Fresh agent session on existing PR branch",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/force-redo",
            description: "Clear everything and re-run from scratch",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/review",
            description: "Manually launch a code review agent",
          },
          {
            method: "POST",
            path: "/api/tasks/reorder",
            description: "Reorder task priorities by position",
          },
        ]}
      />

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Create Task Example</h3>
      <div className="mt-3">
        <CodeBlock title="POST /api/tasks">{`{
  "title": "Add user avatar support",
  "prompt": "Add avatar upload and display to user profiles",
  "repoUrl": "https://github.com/acme/webapp",
  "repoBranch": "main",
  "agentType": "claude",
  "priority": 0
}`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Bulk Operations</h2>
      <RouteTable
        routes={[
          {
            method: "POST",
            path: "/api/tasks/bulk/retry-failed",
            description: "Retry all failed tasks",
          },
          {
            method: "POST",
            path: "/api/tasks/bulk/cancel-active",
            description: "Cancel all running and queued tasks",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Subtasks</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Tasks can have child tasks. Three subtask types are supported:{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">child</code>{" "}
        (independent),{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">step</code>{" "}
        (sequential pipeline), and{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">review</code>{" "}
        (code review).
      </p>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/tasks/:id/subtasks",
            description: "List subtasks of a task",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/subtasks",
            description: "Create a subtask (child, step, or review)",
          },
          {
            method: "GET",
            path: "/api/tasks/:id/subtasks/status",
            description: "Get subtask completion status",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Task Comments</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/tasks/:id/comments",
            description: "List comments on a task",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/comments",
            description: "Add a comment to a task",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Task Dependencies</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/tasks/:id/dependencies",
            description: "List task dependencies",
          },
          {
            method: "POST",
            path: "/api/tasks/:id/dependencies",
            description: "Add a dependency (task must complete before this task starts)",
          },
          {
            method: "DELETE",
            path: "/api/tasks/:id/dependencies/:depId",
            description: "Remove a dependency",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Repositories</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Manage connected repositories and their per-repo settings.
      </p>
      <RouteTable
        routes={[
          { method: "GET", path: "/api/repos", description: "List connected repositories" },
          { method: "POST", path: "/api/repos", description: "Connect a new repository" },
          {
            method: "GET",
            path: "/api/repos/:id",
            description: "Get repository details and settings",
          },
          { method: "PATCH", path: "/api/repos/:id", description: "Update repository settings" },
          { method: "DELETE", path: "/api/repos/:id", description: "Disconnect a repository" },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Issues</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Browse and assign GitHub Issues from connected repositories.
      </p>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/issues",
            description: "List GitHub Issues across all connected repos",
          },
          {
            method: "POST",
            path: "/api/issues/assign",
            description: "Assign a GitHub Issue to Optio (creates a task)",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Tickets</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Manage external ticket provider integrations (GitHub Issues, GitLab Issues, Linear, Jira,
        Notion).
      </p>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/tickets/providers",
            description: "List configured ticket providers",
          },
          { method: "POST", path: "/api/tickets/providers", description: "Add a ticket provider" },
          {
            method: "PATCH",
            path: "/api/tickets/providers/:id",
            description: "Update a ticket provider",
          },
          {
            method: "DELETE",
            path: "/api/tickets/providers/:id",
            description: "Remove a ticket provider",
          },
          {
            method: "POST",
            path: "/api/tickets/sync",
            description: "Trigger a manual ticket sync",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Interactive Sessions</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Sessions provide persistent, interactive workspaces connected to repo pods with terminal and
        agent chat.
      </p>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/sessions",
            description: "List sessions (filterable by state, repo)",
          },
          { method: "POST", path: "/api/sessions", description: "Create an interactive session" },
          { method: "GET", path: "/api/sessions/:id", description: "Get session details" },
          {
            method: "POST",
            path: "/api/sessions/:id/end",
            description: "End a session and clean up worktree",
          },
        ]}
      />
      <p className="mt-3 text-text-muted leading-relaxed">
        Sessions also expose WebSocket endpoints:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            WS /ws/sessions/:id/terminal
          </code>{" "}
          — xterm.js interactive terminal
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            WS /ws/sessions/:id/chat
          </code>{" "}
          — interactive Claude Code chat
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Secrets</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/secrets",
            description: "List secrets (names and scopes only, never values)",
          },
          { method: "POST", path: "/api/secrets", description: "Create or update a secret" },
          { method: "DELETE", path: "/api/secrets/:name", description: "Delete a secret" },
        ]}
      />
      <Callout type="warning">
        Secret values are never returned by the API. Only names and scopes are exposed. Secrets are
        encrypted at rest with AES-256-GCM.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Authentication</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/auth/providers",
            description: "List enabled OAuth providers (no auth required)",
          },
          {
            method: "GET",
            path: "/api/auth/:provider/login",
            description: "Initiate OAuth flow (redirects to provider)",
          },
          {
            method: "GET",
            path: "/api/auth/:provider/callback",
            description: "OAuth callback (sets session cookie)",
          },
          { method: "GET", path: "/api/auth/me", description: "Get current user profile" },
          {
            method: "POST",
            path: "/api/auth/logout",
            description: "Revoke session and clear cookie",
          },
          { method: "GET", path: "/api/auth/status", description: "Claude subscription status" },
          { method: "GET", path: "/api/auth/usage", description: "Claude Max/Pro usage metrics" },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Workspaces</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Multi-tenancy via workspaces. Resources are scoped to the active workspace.
      </p>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/workspaces",
            description: "List workspaces for the current user",
          },
          { method: "POST", path: "/api/workspaces", description: "Create a new workspace" },
          {
            method: "PATCH",
            path: "/api/workspaces/:id",
            description: "Update workspace settings",
          },
          {
            method: "GET",
            path: "/api/workspaces/:id/members",
            description: "List workspace members",
          },
          {
            method: "POST",
            path: "/api/workspaces/:id/members",
            description: "Invite a member to the workspace",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Prompt Templates</h2>
      <RouteTable
        routes={[
          { method: "GET", path: "/api/prompt-templates", description: "List prompt templates" },
          {
            method: "POST",
            path: "/api/prompt-templates",
            description: "Create a prompt template",
          },
          {
            method: "PATCH",
            path: "/api/prompt-templates/:id",
            description: "Update a prompt template",
          },
          {
            method: "DELETE",
            path: "/api/prompt-templates/:id",
            description: "Delete a prompt template",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Task Templates</h2>
      <RouteTable
        routes={[
          { method: "GET", path: "/api/task-templates", description: "List task templates" },
          { method: "POST", path: "/api/task-templates", description: "Create a task template" },
          {
            method: "PATCH",
            path: "/api/task-templates/:id",
            description: "Update a task template",
          },
          {
            method: "DELETE",
            path: "/api/task-templates/:id",
            description: "Delete a task template",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Analytics</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/analytics/costs",
            description: "Cost analytics with daily, per-repo, and per-type breakdowns",
          },
        ]}
      />
      <h3 className="mt-6 text-lg font-semibold text-text-heading">Query Parameters</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Param</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            <tr>
              <td className="px-4 py-3 font-mono text-text-heading">days</td>
              <td className="px-4 py-3 text-text-muted">30</td>
              <td className="px-4 py-3 text-text-muted">Number of days to aggregate</td>
            </tr>
            <tr>
              <td className="px-4 py-3 font-mono text-text-heading">repoUrl</td>
              <td className="px-4 py-3 text-text-muted">all</td>
              <td className="px-4 py-3 text-text-muted">Filter by repository URL</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3 className="mt-6 text-lg font-semibold text-text-heading">Response Shape</h3>
      <div className="mt-3">
        <CodeBlock title="GET /api/analytics/costs?days=30">{`{
  "summary": {
    "totalCost": "12.45",
    "taskCount": 38,
    "averageCost": "0.33",
    "costTrend": 15.2
  },
  "dailyCosts": [
    { "date": "2025-01-15", "cost": "1.20", "taskCount": 4 }
  ],
  "costByRepo": [
    { "repoUrl": "https://github.com/acme/webapp", "cost": "8.30" }
  ],
  "costByType": [
    { "taskType": "coding", "cost": "10.15" },
    { "taskType": "review", "cost": "2.30" }
  ],
  "topTasks": [
    { "id": "abc123", "title": "Refactor auth", "costUsd": "1.85" }
  ]
}`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Webhooks</h2>
      <RouteTable
        routes={[
          { method: "GET", path: "/api/webhooks", description: "List configured webhooks" },
          { method: "POST", path: "/api/webhooks", description: "Create a webhook endpoint" },
          { method: "PATCH", path: "/api/webhooks/:id", description: "Update a webhook" },
          { method: "DELETE", path: "/api/webhooks/:id", description: "Delete a webhook" },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Legacy Aliases</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The following endpoints are retained for backward compatibility. New integrations should use
        the unified{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">/api/tasks</code>{" "}
        surface documented above.
      </p>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/jobs/*",
            description: "Standalone Task alias (use /api/tasks?type=standalone)",
          },
          {
            method: "GET",
            path: "/api/task-configs/*",
            description: "Repo Task blueprint alias (use /api/tasks?type=repo-blueprint)",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Cluster</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/cluster/nodes",
            description: "List cluster nodes with resource usage",
          },
          { method: "GET", path: "/api/cluster/pods", description: "List Optio-managed pods" },
          { method: "GET", path: "/api/cluster/pods/:name/logs", description: "Get pod logs" },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Slack</h2>
      <RouteTable
        routes={[
          {
            method: "POST",
            path: "/api/slack/test",
            description: "Send a test Slack notification",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">MCP Servers</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/mcp-servers",
            description: "List MCP server configurations",
          },
          {
            method: "POST",
            path: "/api/mcp-servers",
            description: "Add an MCP server (global or per-repo)",
          },
          {
            method: "PATCH",
            path: "/api/mcp-servers/:id",
            description: "Update an MCP server config",
          },
          { method: "DELETE", path: "/api/mcp-servers/:id", description: "Remove an MCP server" },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Skills</h2>
      <RouteTable
        routes={[
          { method: "GET", path: "/api/skills", description: "List custom agent skills" },
          { method: "POST", path: "/api/skills", description: "Create a custom skill" },
          { method: "PATCH", path: "/api/skills/:id", description: "Update a skill" },
          { method: "DELETE", path: "/api/skills/:id", description: "Delete a skill" },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Setup</h2>
      <RouteTable
        routes={[
          {
            method: "GET",
            path: "/api/setup/status",
            description: "Check if initial setup is complete",
          },
          {
            method: "POST",
            path: "/api/setup/complete",
            description: "Complete the initial setup wizard",
          },
        ]}
      />

      <h2 className="mt-10 text-2xl font-bold text-text-heading">WebSocket Endpoints</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Real-time communication uses WebSocket connections authenticated via{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">?token=</code>{" "}
        query parameter.
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
              ["/ws/logs/:taskId", "Stream real-time structured logs for a task"],
              ["/ws/events", "Global event stream (task state changes, new tasks, etc.)"],
              ["/ws/sessions/:id/terminal", "Interactive terminal for a session (xterm.js)"],
              ["/ws/sessions/:id/chat", "Interactive Claude Code chat for a session"],
            ].map(([endpoint, desc]) => (
              <tr key={endpoint}>
                <td className="px-4 py-3 font-mono text-text-heading">{endpoint}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
