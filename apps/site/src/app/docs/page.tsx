import type { Metadata } from "next";
import Link from "next/link";
import { docsNav } from "@/content/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Optio documentation — learn how to install, configure, and run AI coding agents with autonomous feedback loops on Kubernetes.",
};

const sectionIcons: Record<string, string> = {
  "Getting Started": "\u2192",
  "Core Concepts": "\u25CE",
  Guides: "\u26A1",
  Reference: "\u2699",
};

const sectionDescriptions: Record<string, string> = {
  "Getting Started":
    "Install Optio, run the setup script, and configure your first repository and agent.",
  "Core Concepts":
    "Understand the architecture — pod-per-repo isolation, worktree concurrency, and the task state machine.",
  Guides:
    "Step-by-step walkthroughs for creating tasks, connecting repos, configuring review agents, building workflows, setting up connections, and integrating with external tools.",
  Reference: "API endpoints, production deployment guide, and contributor documentation.",
};

export default function DocsIndex() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Documentation</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Optio is an orchestration system for AI coding agents. One primary concept — a{" "}
        <strong>Task</strong> — configures the agent to do something. Attach a repo and the Task
        drives tickets to merged PRs with an autonomous feedback loop; leave the repo off and the
        Task runs the agent standalone (reports, triage, automations) with no git checkout. Either
        flavor supports schedule, webhook, and ticket triggers, and connects agents to external
        services like Notion, Slack, Linear, and PostgreSQL via MCP.
      </p>
      <p className="mt-3 text-text-muted leading-relaxed">
        New here?{" "}
        <Link href="/docs/getting-started" className="text-primary-light hover:underline">
          Start with the quickstart guide
        </Link>{" "}
        to get a local instance running in minutes.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {docsNav.map((section) => (
          <div key={section.title} className="rounded-xl border border-border bg-bg-card p-6">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-subtle text-sm font-mono text-text-muted">
                {sectionIcons[section.title] ?? "\u25C7"}
              </span>
              <h2 className="text-lg font-semibold text-text-heading">{section.title}</h2>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
              {sectionDescriptions[section.title]}
            </p>
            <ul className="mt-4 space-y-2">
              {section.pages.map((page) => (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    className="group flex items-center gap-2 text-[14px] text-text-muted hover:text-primary-light transition-colors"
                  >
                    <span className="text-border-strong group-hover:text-primary-light transition-colors">
                      {"\u203A"}
                    </span>
                    {page.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
