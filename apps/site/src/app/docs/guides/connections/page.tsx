import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Connections",
  description:
    "Connect external services to your AI agents via MCP. Built-in providers for Notion, Slack, Linear, GitHub, PostgreSQL, Sentry, and more.",
};

export default function ConnectionsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Connections</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Connections give your AI agents access to external services and data at runtime. Configure a
        provider once, assign it to specific repos or agent types, and Optio automatically injects
        it into agent pods when tasks execute.
      </p>
      <p className="mt-3 text-text-muted leading-relaxed">
        Under the hood, connections use the{" "}
        <a
          href="https://modelcontextprotocol.io/"
          className="text-primary-light hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          Model Context Protocol (MCP)
        </a>{" "}
        to extend agent capabilities. When a task runs, Optio resolves which connections apply,
        starts the corresponding MCP servers in the pod, and the agent can use them as tools.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">How It Works</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Connections follow a three-layer architecture:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Providers</strong> — catalog entries that define a
          service type (e.g., &ldquo;Notion&rdquo;, &ldquo;PostgreSQL&rdquo;). Built-in providers
          ship with Optio; you can also create custom ones.
        </li>
        <li>
          <strong className="text-text-heading">Connections</strong> — configured instances of a
          provider with your API keys and settings. For example, &ldquo;Production Notion&rdquo;
          with your team&apos;s integration token.
        </li>
        <li>
          <strong className="text-text-heading">Assignments</strong> — rules that control which
          repos and agent types can access a connection, with permission levels (read, readwrite,
          full).
        </li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Built-in Providers</h2>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Provider</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Category</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Capabilities</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["Notion", "Productivity", "Search pages, databases, and comments"],
              ["GitHub", "Productivity", "Issues, PRs, discussions, repository content"],
              ["Slack", "Productivity", "Search messages, read channels, post messages"],
              ["Linear", "Productivity", "Issues, projects, and cycles management"],
              ["PostgreSQL", "Database", "Query databases, inspect schema"],
              ["Sentry", "Cloud", "Search errors, stack traces, issue management"],
              ["Filesystem", "Knowledge", "Read and search files from mounted directories"],
              ["Custom MCP Server", "Custom", "Any MCP-compatible server with custom command"],
              ["HTTP API", "Custom", "Any REST API with configurable authentication"],
            ].map(([provider, category, capabilities]) => (
              <tr key={provider}>
                <td className="px-4 py-3 font-medium text-text-heading">{provider}</td>
                <td className="px-4 py-3 text-text-muted">{category}</td>
                <td className="px-4 py-3 text-text-muted">{capabilities}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Creating a Connection</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Navigate to <strong className="text-text-heading">Connections</strong> in the dashboard.
        Select a provider from the catalog, fill in the configuration (API keys, tokens, URLs), and
        optionally configure access control.
      </p>
      <div className="mt-4">
        <CodeBlock title="API: Create a connection">{`POST /api/connections
{
  "name": "Team Notion",
  "providerId": "<notion-provider-id>",
  "config": {
    "NOTION_TOKEN": "ntn_..."
  },
  "scope": "global",
  "enabled": true
}`}</CodeBlock>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        By default, new connections are globally available to all repos and agent types. Use
        assignments to restrict access.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Custom MCP Servers</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        If you have an MCP server not in the built-in catalog, use the &ldquo;Custom MCP
        Server&rdquo; provider. Specify the command, arguments, and environment variables:
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Create custom MCP connection">{`POST /api/connections
{
  "name": "Internal Docs Server",
  "providerId": "<custom-mcp-provider-id>",
  "config": {
    "command": "npx",
    "args": ["-y", "@myorg/docs-mcp-server"],
    "env": { "DOCS_API_KEY": "..." }
  },
  "scope": "global",
  "enabled": true
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">HTTP APIs</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        For REST APIs that aren&apos;t MCP-compatible, use the &ldquo;HTTP API&rdquo; provider.
        Supports no-auth, API key, and bearer token authentication.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Access Control</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Assignments control which repos and agent types can use a connection. Each assignment
        specifies:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Repository</strong> — a specific repo, or all repos
          (global)
        </li>
        <li>
          <strong className="text-text-heading">Agent types</strong> — restrict to specific agents
          (e.g., only Claude Code), or allow all
        </li>
        <li>
          <strong className="text-text-heading">Permission</strong> —{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">read</code>,{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">readwrite</code>
          , or <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">full</code>
        </li>
      </ul>
      <div className="mt-4">
        <CodeBlock title="API: Create an assignment">{`POST /api/connections/:id/assignments
{
  "repoId": "repo-uuid",
  "agentTypes": ["claude-code"],
  "permission": "readwrite"
}`}</CodeBlock>
      </div>

      <Callout type="tip">
        Leave{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">repoId</code> null
        and{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">agentTypes</code>{" "}
        empty to make a connection available to all repos and all agent types.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">How Connections Are Injected</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        When a task runs, the task worker resolves applicable connections:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>Looks up enabled connections matching the task&apos;s workspace</li>
        <li>Filters by assignment rules (repo URL and agent type)</li>
        <li>Builds MCP configuration entries with resolved secrets and environment variables</li>
        <li>
          Writes the configuration into the agent pod&apos;s{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">.mcp.json</code>
        </li>
        <li>The agent discovers and uses the MCP servers as tools during execution</li>
      </ol>
      <p className="mt-3 text-text-muted leading-relaxed">
        Secrets are resolved at runtime and injected into the pod environment. They are never
        exposed in the web UI or API responses.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Health Checking</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Each connection tracks its health status:{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">healthy</code>,{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">error</code>, or{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">unknown</code>.
        Test a connection from the dashboard or via the API:
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Test connection">{`POST /api/connections/:id/test`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Managing Connections</h2>
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
              ["GET /api/connection-providers", "List available providers"],
              ["GET /api/connections", "List configured connections"],
              ["POST /api/connections", "Create a new connection"],
              ["PATCH /api/connections/:id", "Update connection config or status"],
              ["DELETE /api/connections/:id", "Delete connection and its assignments"],
              ["POST /api/connections/:id/test", "Test connection health"],
              ["GET /api/connections/:id/assignments", "List assignments"],
              ["POST /api/connections/:id/assignments", "Create assignment"],
              ["DELETE /api/connection-assignments/:id", "Delete assignment"],
              ["GET /api/repos/:id/connections", "List connections for a repo"],
            ].map(([endpoint, desc]) => (
              <tr key={endpoint}>
                <td className="px-4 py-3 font-mono text-text-heading">{endpoint}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Standalone Tasks",
            href: "/docs/guides/standalone-tasks",
            description: "Run standalone agent jobs with triggers",
          },
          {
            title: "Integrations",
            href: "/docs/guides/integrations",
            description: "Connect ticket sources and webhooks",
          },
          {
            title: "Creating Tasks",
            href: "/docs/guides/creating-tasks",
            description: "Create repo-based coding tasks",
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
