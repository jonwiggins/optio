import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Contributing",
  description:
    "Contribute to Optio — the open-source AI agent orchestrator. Learn the dev workflow, coding conventions, commit standards, and how to submit PRs.",
};

export default function ContributingPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Contributing</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Thanks for your interest in contributing to Optio! This guide covers the development setup,
        project structure, workflow, and conventions.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Development Setup</h2>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Prerequisites</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Node.js 22+</strong>
        </li>
        <li>
          <strong className="text-text-heading">pnpm 10+</strong> (
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            npm install -g pnpm
          </code>
          )
        </li>
        <li>
          <strong className="text-text-heading">Docker Desktop</strong> with Kubernetes enabled
        </li>
        <li>
          <strong className="text-text-heading">Helm 3+</strong> and{" "}
          <strong className="text-text-heading">kubectl</strong>
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Quick Start</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`git clone https://github.com/jonwiggins/optio.git
cd optio
pnpm install

# Start Kubernetes infrastructure
./scripts/setup-local.sh

# Start dev servers (API + Web) with hot reload
pnpm dev`}</CodeBlock>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        The API runs on{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          http://localhost:4000
        </code>{" "}
        and the web UI on{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          http://localhost:3000
        </code>
        .
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Building the Agent Image</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`docker build -t optio-agent:latest -f Dockerfile.agent .

# Load into K8s containerd (Docker Desktop)
docker save optio-agent:latest | \\
  docker exec -i desktop-control-plane \\
  ctr -n k8s.io image import --digests -`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Project Structure</h2>
      <div className="mt-3">
        <CodeBlock>{`apps/api/       Fastify API server + BullMQ workers
apps/web/       Next.js web UI
packages/       Shared libraries (types, runtime, adapters, providers)
helm/           Production Helm charts
images/         Agent container Dockerfiles
k8s/            Local dev K8s manifests`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Key Directories</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Path</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Contents</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["apps/api/src/routes/", "API route handlers (tasks, repos, secrets, auth, etc.)"],
              ["apps/api/src/services/", "Business logic (task-service, repo-pool, review, etc.)"],
              ["apps/api/src/workers/", "BullMQ workers (task, PR watcher, cleanup, sync)"],
              ["apps/api/src/db/", "Drizzle schema (~26 tables) and migrations (~28)"],
              ["apps/web/src/app/", "Next.js App Router pages"],
              ["apps/web/src/components/", "React components (task-card, log-viewer, etc.)"],
              ["packages/shared/", "Types, state machine, prompt renderer, error classifier"],
              ["packages/container-runtime/", "Kubernetes container runtime interface"],
              [
                "packages/agent-adapters/",
                "Claude Code, Codex, Copilot, Gemini, OpenCode, and Cursor agent adapters",
              ],
              [
                "packages/ticket-providers/",
                "GitHub Issues, GitLab Issues, Linear, Jira, and Notion ticket providers",
              ],
            ].map(([path, contents]) => (
              <tr key={path}>
                <td className="px-4 py-3 font-mono text-text-heading">{path}</td>
                <td className="px-4 py-3 text-text-muted">{contents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Commands</h2>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# Development
pnpm dev              # Start API + Web with hot reload
pnpm dev:api          # Fastify API on :4000
pnpm dev:web          # Next.js on :3100

# Quality checks (same as CI + pre-commit hooks)
pnpm format:check     # Check formatting (Prettier)
pnpm format           # Auto-fix formatting
pnpm lint             # Lint with ESLint
pnpm turbo typecheck  # Typecheck all 6 packages
pnpm turbo test       # Run tests (Vitest)

# Build
cd apps/web && npx next build    # Verify production web build
./images/build.sh                # Build all agent image presets

# Database
cd apps/api && npx drizzle-kit generate  # Generate migration
cd apps/api && npx drizzle-kit migrate   # Apply migration

# Helm
helm lint helm/optio --set encryption.key=test
helm upgrade optio helm/optio -n optio --reuse-values`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Development Workflow</h2>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Database Changes</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        The database schema is defined with Drizzle ORM. After editing the schema, generate and
        apply a migration:
      </p>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# 1. Edit the schema
#    apps/api/src/db/schema.ts

# 2. Generate a migration
cd apps/api && npx drizzle-kit generate

# 3. Apply (migrations also auto-run on API startup)
cd apps/api && npx drizzle-kit migrate`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Adding a New API Route</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Create the route handler in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            apps/api/src/routes/
          </code>
        </li>
        <li>
          Register it in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            apps/api/src/server.ts
          </code>
        </li>
        <li>
          Add the API client method in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            apps/web/src/lib/api-client.ts
          </code>
        </li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Conventions</h2>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Code Style</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">TypeScript</strong> with strict mode everywhere
        </li>
        <li>
          <strong className="text-text-heading">ESM modules</strong> — use{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">.js</code>{" "}
          extensions in imports (TypeScript resolves them to{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">.ts</code>)
        </li>
        <li>
          <strong className="text-text-heading">Prettier</strong> for formatting (runs on commit via
          Husky)
        </li>
        <li>
          <strong className="text-text-heading">Tailwind CSS v4</strong> —{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            @import &quot;tailwindcss&quot;
          </code>{" "}
          + <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">@theme</code>{" "}
          block in CSS, no{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            tailwind.config
          </code>{" "}
          file
        </li>
        <li>
          <strong className="text-text-heading">Zustand</strong> for client state — use{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            useStore.getState()
          </code>{" "}
          in callbacks/effects, not hook selectors
        </li>
        <li>
          <strong className="text-text-heading">Zod</strong> for API request validation
        </li>
        <li>
          <strong className="text-text-heading">Drizzle ORM</strong> for database access
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Important Patterns</h3>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">State transitions</strong> — always go through{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            taskService.transitionTask()
          </code>{" "}
          which validates, updates DB, records an event, and publishes to WebSocket
        </li>
        <li>
          <strong className="text-text-heading">Secrets</strong> — never log or return secret
          values. Only names and scopes are exposed via API. Encrypted at rest with AES-256-GCM
        </li>
        <li>
          <strong className="text-text-heading">Cost tracking</strong> — stored as string (
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">costUsd</code>)
          to avoid floating-point precision issues
        </li>
        <li>
          <strong className="text-text-heading">Error handling</strong> — use the error classifier (
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            @optio/shared
          </code>
          ) for user-facing messages, raw errors in logs
        </li>
        <li>
          <strong className="text-text-heading">WebSocket events</strong> — published to Redis
          pub/sub channels, relayed to browser clients
        </li>
        <li>
          <strong className="text-text-heading">Next.js webpack config</strong> —{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            extensionAlias
          </code>{" "}
          in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            next.config.ts
          </code>{" "}
          resolves{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">.js</code> to{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">.ts</code> for
          workspace packages
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Commit Conventions</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio uses{" "}
        <a
          href="https://www.conventionalcommits.org/"
          className="text-primary-light hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          Conventional Commits
        </a>
        , enforced by commitlint via a Husky commit-msg hook.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Prefix</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Usage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["feat:", "A new feature"],
              ["fix:", "A bug fix"],
              ["docs:", "Documentation changes"],
              ["style:", "Formatting, no code change"],
              ["refactor:", "Code change that neither fixes nor adds"],
              ["perf:", "Performance improvement"],
              ["test:", "Add or update tests"],
              ["build:", "Build system or dependencies"],
              ["ci:", "CI configuration"],
              ["chore:", "Maintenance"],
            ].map(([prefix, usage]) => (
              <tr key={prefix}>
                <td className="px-4 py-3 font-mono text-text-heading">{prefix}</td>
                <td className="px-4 py-3 text-text-muted">{usage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Pre-Commit Hooks</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Husky runs the following checks before each commit, mirroring CI:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">lint-staged</strong> — runs ESLint + Prettier on
          staged files
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            pnpm format:check
          </code>{" "}
          — verifies formatting across the entire project
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            pnpm turbo typecheck
          </code>{" "}
          — typechecks all packages
        </li>
      </ol>

      <Callout type="tip">
        Run{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">pnpm format</code>{" "}
        to auto-fix formatting issues before committing. This saves time when the pre-commit hook
        catches formatting problems.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Pull Requests</h2>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>Fork the repo and create a feature branch</li>
        <li>Make your changes with tests</li>
        <li>
          Ensure{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            pnpm turbo typecheck
          </code>{" "}
          and{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            pnpm turbo test
          </code>{" "}
          pass
        </li>
        <li>Submit a PR using the template</li>
        <li>Wait for CI to pass and a maintainer review</li>
      </ol>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">CI Checks</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        GitHub Actions runs the following on every PR:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>Format check (Prettier)</li>
        <li>Typecheck all packages</li>
        <li>Run tests (Vitest)</li>
        <li>Build web app (Next.js production build)</li>
        <li>Build agent image</li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">License</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio is MIT licensed. See the{" "}
        <a
          href="https://github.com/jonwiggins/optio/blob/main/LICENSE"
          className="text-primary-light hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          LICENSE
        </a>{" "}
        file for details.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Architecture",
            href: "/docs/architecture",
            description: "Understand the system design",
          },
          {
            title: "API Reference",
            href: "/docs/api-reference",
            description: "Full REST API documentation",
          },
          {
            title: "Configuration",
            href: "/docs/configuration",
            description: "Environment variables and settings",
          },
          {
            title: "Task Lifecycle",
            href: "/docs/task-lifecycle",
            description: "States, transitions, and feedback loop",
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
