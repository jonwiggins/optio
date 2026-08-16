import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Connecting Repos",
  description:
    "How to connect repositories, configure per-repo settings, and choose image presets.",
};

export default function ConnectingReposPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Connecting Repos</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Before you can create tasks, you need to connect at least one repository. Optio supports any
        Git repository accessible via HTTPS. Each repository gets its own configuration for agent
        behavior, concurrency limits, and review settings.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Adding a Repository</h2>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Navigate to <strong className="text-text-heading">Repos</strong> in the sidebar
        </li>
        <li>
          Click <strong className="text-text-heading">Add Repository</strong>
        </li>
        <li>
          Enter the repository URL (e.g.,{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            https://github.com/acme/webapp
          </code>
          )
        </li>
        <li>Optio auto-detects the language, default branch, and suggests an image preset</li>
        <li>Confirm the settings and connect</li>
      </ol>

      <Callout type="info">
        A{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          GITHUB_TOKEN
        </code>{" "}
        secret is required for private repositories and for auto-detection features. Add it in{" "}
        <strong className="text-text-heading">Secrets</strong> before connecting private repos.
      </Callout>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Via the API</h3>
      <div className="mt-3">
        <CodeBlock title="POST /api/repos">{`{
  "repoUrl": "https://github.com/acme/webapp",
  "imagePreset": "node",
  "defaultBranch": "main"
}`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Auto-Detection</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        When you add a repo, Optio queries the GitHub API for root-level files and automatically
        detects the language and tooling:
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Detected File</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Image Preset</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Test Command</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["package.json", "node", "npm test"],
              ["Cargo.toml", "rust", "cargo test"],
              ["go.mod", "go", "go test ./..."],
              ["pyproject.toml / setup.py / requirements.txt", "python", "pytest"],
              ["Multiple languages", "full", "(varies)"],
            ].map(([file, preset, cmd]) => (
              <tr key={file}>
                <td className="px-4 py-3 font-mono text-text-heading">{file}</td>
                <td className="px-4 py-3 text-text-muted">{preset}</td>
                <td className="px-4 py-3 font-mono text-text-muted">{cmd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        You can always override the auto-detected preset and test command in the repo settings.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Image Presets</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Image presets determine the Docker image used for the repo pod. Each preset comes with the
        appropriate language runtime and tooling pre-installed.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Preset</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Includes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["base", "Git, common CLI tools, Claude Code, Copilot, Gemini, OpenCode, Cursor"],
              ["node", "Base + Node.js, npm, pnpm, yarn"],
              ["python", "Base + Python, pip, poetry, uv"],
              ["go", "Base + Go toolchain"],
              ["rust", "Base + Rust, cargo, rustup"],
              ["full", "All language runtimes combined"],
            ].map(([preset, includes]) => (
              <tr key={preset}>
                <td className="px-4 py-3 font-mono text-text-heading">{preset}</td>
                <td className="px-4 py-3 text-text-muted">{includes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Callout type="tip">
        Use the most specific preset for your repo. The{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">full</code> preset
        works for polyglot repos but produces a larger image and slower pod startup.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Custom Setup Scripts</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        If your repo needs custom setup beyond the image preset (e.g., installing system packages,
        configuring environment variables, or running a build step), add an{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          .optio/setup.sh
        </code>{" "}
        file to your repository root. This script runs automatically when the repo pod is first
        created, after the clone completes.
      </p>
      <div className="mt-3">
        <CodeBlock title=".optio/setup.sh">{`#!/bin/bash
# Install project dependencies
npm install

# Build shared packages
npm run build:packages

# Install additional system tools
apt-get update && apt-get install -y jq`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Per-Repo Settings</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Each repository has a comprehensive settings page accessible from{" "}
        <strong className="text-text-heading">Repos &rarr; (select repo) &rarr; Settings</strong>.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Concurrency</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["maxConcurrentTasks", "2", "Maximum concurrent tasks for this repo"],
              ["maxPodInstances", "1", "Maximum pod replicas (1-20). Each gets its own PVC"],
              ["maxAgentsPerPod", "2", "Maximum concurrent agents per pod instance (1-50)"],
            ].map(([setting, def, desc]) => (
              <tr key={setting}>
                <td className="px-4 py-3 font-mono text-text-heading">{setting}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        Total capacity ={" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          maxPodInstances &times; maxAgentsPerPod
        </code>
        . When all pods are at capacity and under the instance limit, Optio dynamically creates a
        new pod. Higher-index pods are removed first when idle (LIFO scaling).
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Agent Behavior</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["claudeModel", "Model for coding tasks (sonnet, opus, haiku)"],
              ["claudeContextWindow", "Context window override (null = model default)"],
              ["claudeThinking", "Enable extended thinking mode for more complex reasoning"],
              ["claudeEffort", "Agent effort level override"],
              ["maxTurnsCoding", "Limit agent turns for coding tasks (controls cost)"],
              ["maxTurnsReview", "Limit agent turns for review tasks"],
              ["autoMerge", "Auto-merge PRs when CI passes and review is approved"],
              ["autoResume", "Auto-resume agent when reviewer requests changes"],
            ].map(([setting, desc]) => (
              <tr key={setting}>
                <td className="px-4 py-3 font-mono text-text-heading">{setting}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Prompt Template Override</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Each repo can override the global prompt template. This is useful for repos with specific
        conventions, testing requirements, or architectural constraints.
      </p>
      <div className="mt-3">
        <CodeBlock title="example repo prompt override">{`Read the task description from {{TASK_FILE}}.

This is a Next.js 15 project using the App Router. Follow these conventions:
- Server Components by default, "use client" only when needed
- All data fetching in Server Components
- Use the existing design system in src/components/ui/
- Run "pnpm turbo typecheck" before opening the PR
- Include tests in __tests__/ directories

Create a branch named "{{BRANCH_NAME}}" and open a PR when done.`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Repository URL Normalization</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio normalizes all repository URLs to a canonical HTTPS form for consistent matching. The
        following formats all resolve to the same repo:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            https://github.com/acme/webapp
          </code>
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            https://github.com/acme/webapp.git
          </code>
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            git@github.com:acme/webapp.git
          </code>
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            ssh://git@github.com/acme/webapp
          </code>
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Pod Lifecycle</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Understanding how repo pods work helps with troubleshooting:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Creation</strong> — When the first task arrives for
          a repo, a pod is created, the repo is cloned, and{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            .optio/setup.sh
          </code>{" "}
          runs if present
        </li>
        <li>
          <strong className="text-text-heading">Reuse</strong> — Subsequent tasks reuse the existing
          pod. The repo is already cloned and dependencies installed
        </li>
        <li>
          <strong className="text-text-heading">Persistence</strong> — Pods use persistent volumes,
          so installed tools and caches survive pod restarts
        </li>
        <li>
          <strong className="text-text-heading">Idle cleanup</strong> — Pods idle for 10 minutes
          (configurable) before being removed
        </li>
        <li>
          <strong className="text-text-heading">Health monitoring</strong> — The cleanup worker
          detects crashed or OOM-killed pods, fails associated tasks, and deletes the dead pod
          record so the next task recreates it
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Creating Tasks",
            href: "/docs/guides/creating-tasks",
            description: "Create tasks from UI, issues, or API",
          },
          {
            title: "Review Agents",
            href: "/docs/guides/review-agents",
            description: "Set up automated code review",
          },
          {
            title: "Configuration",
            href: "/docs/configuration",
            description: "All environment variables and settings",
          },
          {
            title: "Architecture",
            href: "/docs/architecture",
            description: "Pod-per-repo design and scaling",
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
