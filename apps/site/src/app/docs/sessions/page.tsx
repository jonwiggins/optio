import type { Metadata } from "next";
import Link from "next/link";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Sessions",
  description:
    "The Optio session model — one noun with five attributes (When, Where, Who, What, Then) that covers PR tasks, scheduled jobs, laptop automations, interactive terminals, and persistent multi-agent systems.",
};

const attributes: Array<{ name: string; question: string; values: string[] }> = [
  {
    name: "When",
    question: "What starts it?",
    values: [
      "Now",
      "A cron schedule",
      "A webhook (POST /api/hooks/<path>)",
      "A ticket — GitHub Issues, GitLab Issues, Linear, Jira, Notion",
      "A GitHub, Slack, or Linear event (runs on your machine)",
      "A message from a person or another agent (persistent agents)",
    ],
  },
  {
    name: "Where",
    question: "Where does it run?",
    values: [
      "An Optio pod in your cluster with one of your registered repos checked out",
      "An Optio pod with no repo",
      "A directory on your own machine, as it is (Optio Local)",
      "A new branch in a checkout on your machine that becomes a PR",
    ],
  },
  {
    name: "Who",
    question: "What does the work?",
    values: [
      "A bare terminal with no agent",
      "Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, Cursor, OpenCode, or OpenClaw",
      "…with the model and provider options you choose",
    ],
  },
  {
    name: "What",
    question: "What is it asked to do?",
    values: [
      "A prompt, or a saved prompt template from the Library",
      "{{param}} substitution and {{#if param}} blocks filled from the trigger payload",
    ],
  },
  {
    name: "Then",
    question: "What happens after a turn?",
    values: [
      "Exits when done — opens a PR or produces side effects, then stops",
      "Waits for you — an interactive session that halts at the agent's prompt between turns",
      "Persistent agent — keeps memory, wakes on messages, addressable by other agents",
    ],
  },
];

const kinds: Array<[string, string, string]> = [
  [
    "Pod + repo, exits when done",
    "PR session (task)",
    "Worktree in a repo pod → agent → PR → CI → review → merge",
  ],
  [
    "Pod + repo, exits, with a trigger",
    "Blueprint",
    "A saved definition; each firing spawns a fresh PR session",
  ],
  [
    "Pod, no repo, exits when done",
    "Job",
    "One run on a pooled job pod; add a trigger to make it recurring",
  ],
  [
    "Your machine, with a trigger",
    "Local automation",
    "An agent spawned in your checkout on a schedule, webhook, ticket, or event",
  ],
  [
    "Your machine, waits for you",
    "Local terminal",
    "An interactive terminal or agent on a paired machine",
  ],
  ["Pod, waits for you", "Pod session", "An interactive terminal + agent chat inside a repo pod"],
  ["Persistent agent", "Agent", "Long-lived, named, message-driven; inbox, turns, inter-agent API"],
];

const statuses: Array<[string, string]> = [
  ["needs you", "An interactive session is waiting for input"],
  ["running", "An agent is working, or a pod is provisioning"],
  ["queued", "Waiting for capacity"],
  ["waiting", "Open but idle — a PR waiting on CI or review, an agent between turns"],
  ["scheduled", "A recurring definition with an enabled trigger"],
  ["paused", "Triggers disabled, or a paused agent"],
  ["done", "Completed, merged, or exited cleanly"],
  ["failed", "Failed, cancelled, closed without merge, or the pod / terminal died"],
];

export default function SessionsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Sessions</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Everything Optio runs is a <strong className="text-text-heading">session</strong>: a
        one-shot PR task, a nightly report, an automation that wakes when someone requests your
        review on GitHub, a Claude Code terminal on your laptop that you can pick up from your
        phone, or a long-lived agent that other agents message. They differ only in five attributes,
        so one form creates any of them and one feed shows them all.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">The five attributes</h2>
      <div className="mt-4 space-y-4">
        {attributes.map((a) => (
          <div key={a.name} className="rounded-xl border border-border bg-bg-card p-5">
            <div className="flex items-baseline gap-3">
              <h3 className="text-[16px] font-bold text-text-heading">{a.name}</h3>
              <span className="text-[13px] text-text-muted">{a.question}</span>
            </div>
            <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
              {a.values.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-4 text-text-muted leading-relaxed">
        Plus a name (or &quot;Session N&quot;). The New Session form at{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          /sessions/new
        </code>{" "}
        asks these in order, each answer narrowing the next — an event trigger forces the machine
        location, a bare terminal skips the prompt, a persistent agent lives in a pod — and reads
        the draft back as a sentence whose gaps double as validation:
      </p>
      <div className="mt-4 space-y-2 font-mono text-[13px] text-text-muted">
        {[
          "Started by Linear events, a Claude Code session on my laptop on a new branch in ~/src/app that opens a PR and exits when done.",
          "Running weekdays at 09:00 UTC, an OpenAI Codex session in an Optio pod that exits when done.",
          "Woken by messages, a Claude Code agent in an Optio pod that keeps its memory between turns.",
        ].map((line) => (
          <p key={line} className="rounded-lg border border-border bg-bg-card px-4 py-2.5">
            {line}
          </p>
        ))}
      </div>
      <Callout type="tip" title="Presets">
        <strong>Open a PR</strong>, <strong>Interactive chat</strong>,{" "}
        <strong>Scheduled run</strong>, and <strong>Persistent agent</strong> seed the common
        shapes. Any combination of the five attributes is reachable from there.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">What each combination becomes</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The runtime a session gets is a pure function of its attributes. Each kind keeps the
        pipeline it always had; the session model only changes where you create it and where you see
        it.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Attributes</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Kind</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">What runs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {kinds.map(([attrs, kind, what]) => (
              <tr key={kind}>
                <td className="px-4 py-3 text-text-muted">{attrs}</td>
                <td className="px-4 py-3 font-medium text-text-heading">{kind}</td>
                <td className="px-4 py-3 text-text-muted">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        PR sessions follow the{" "}
        <Link href="/docs/task-lifecycle" className="text-primary-light hover:underline">
          task lifecycle
        </Link>{" "}
        with its autonomous feedback loop. Jobs and blueprints are covered in{" "}
        <Link href="/docs/guides/standalone-tasks" className="text-primary-light hover:underline">
          Standalone Tasks
        </Link>{" "}
        and{" "}
        <Link href="/docs/guides/scheduled-tasks" className="text-primary-light hover:underline">
          Scheduled Tasks
        </Link>
        . Persistent agents and Optio Local are documented in the repository under{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">docs/</code>.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">The Sessions feed</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">/sessions</code>{" "}
        merges every kind into one list with four views —{" "}
        <strong className="text-text-heading">Active</strong>,{" "}
        <strong className="text-text-heading">Recurring</strong> (definitions that spawn runs),{" "}
        <strong className="text-text-heading">Agents</strong>, and{" "}
        <strong className="text-text-heading">History</strong> — sorted needs-you first, then live,
        then by recency. Every row carries the same status scale:
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Meaning</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {statuses.map(([status, meaning]) => (
              <tr key={status}>
                <td className="px-4 py-3 font-mono text-text-heading">{status}</td>
                <td className="px-4 py-3 text-text-muted">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        The Overview&apos;s board and the iOS app&apos;s Sessions tab (with widgets, a Live
        Activity, and Dynamic Island) are built on the same projection.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Swarms</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        A session whose <strong className="text-text-heading">Then</strong> is{" "}
        <em>persistent agent</em> keeps its memory between turns and wakes on messages. Agents in a
        workspace can list, message, and broadcast to each other over an inter-agent HTTP API, which
        is what turns a set of sessions into a swarm: a dispatcher that fans work out to
        specialists, a reviewer that closes the loop, all with per-agent pod lifecycle (
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">always-on</code>,{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">sticky</code>,{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">on-demand</code>
        ). Their turns land in the same feed, cost ledger, and Overview as everything else.
      </p>

      <Callout type="info" title="Under the hood">
        The kinds map onto existing tables and services (<code>tasks</code>,{" "}
        <code>task_configs</code>, <code>workflows</code>, <code>local_blueprints</code>,{" "}
        <code>local_terminals</code>, <code>interactive_sessions</code>,{" "}
        <code>persistent_agents</code>) and the polymorphic <code>/api/tasks</code> resource still
        serves the pod-side kinds. See <code>docs/tasks.md</code> in the repository for the mapping
        and the API surface.
      </Callout>
    </>
  );
}
