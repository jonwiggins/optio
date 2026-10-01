import type { Metadata } from "next";
import Link from "next/link";
import { WorkComposer } from "@/components/platform/work-composer";
import { WorkDiagram } from "@/components/platform/work-diagram";

export const metadata: Metadata = {
  title: "One noun: Work — Optio's approach to an AI platform",
  description:
    "Optio composes AI work from five answers — When, Where, Who, Environment, and Then — and any answer combines with any other. One model of work in the backend, on the web, and on your phone.",
};

const ANSWERS = [
  {
    name: "When",
    color: "#a78bfa",
    text: "now, a cron, a webhook, a ticket, a GitHub, Slack, or Linear event, or a message from a person or another agent.",
  },
  {
    name: "Where",
    color: "#60a5fa",
    text: "an isolated pod, with one of your repos or none, or a directory on your own machine.",
  },
  {
    name: "Who",
    color: "#f0a040",
    text: "Claude Code, Codex, Copilot, Gemini, Cursor, OpenCode, or a plain shell command.",
  },
  {
    name: "Environment",
    color: "#818cf8",
    text: "the repo's MCP servers, connections, skills, secrets, and setup as defaults — each piece of work adds or removes.",
  },
  {
    name: "Then",
    color: "#34d399",
    text: "exit when done, work the PR until it merges, wait for you, or stay on as an agent with memory.",
  },
];

function Shot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="my-10">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="w-full rounded-xl border border-border shadow-2xl shadow-black/40"
      />
      <figcaption className="mt-3 text-center text-[13px] text-text-muted">{caption}</figcaption>
    </figure>
  );
}

export default function PlatformArticle() {
  return (
    <article className="px-6 pt-24 pb-24">
      <div className="mx-auto max-w-3xl">
        <p className="text-[12px] font-semibold uppercase tracking-widest text-primary-light">
          The Optio approach
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-text-heading sm:text-5xl">
          One noun: Work
        </h1>
        <p className="mt-6 text-lg leading-8 text-text-muted">
          Most agent tools ship features: a PR bot, a cron runner, a chat window. Optio ships a
          grammar. Every piece of work is five answers, and any answer combines with any other — so
          a new trigger starts everything, and a new runtime runs everywhere.
        </p>

        <div className="mt-10">
          <WorkComposer />
        </div>

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">Five answers</h2>
        <ul className="mt-6 space-y-3">
          {ANSWERS.map((a) => (
            <li key={a.name} className="flex gap-3 leading-7 text-text">
              <span
                className="mt-2.5 h-2 w-2 shrink-0 rounded-full"
                style={{ background: a.color }}
              />
              <span>
                <strong style={{ color: a.color }}>{a.name}</strong> — {a.text}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-6 leading-7 text-text-muted">
          What stays apart is only what doesn&apos;t make sense: following a PR to merge needs an
          agent and a repo, and a persistent agent lives where it can always be reached.
        </p>

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">
          One model, all the way down
        </h2>
        <p className="mt-4 leading-7 text-text-muted">
          The answers aren&apos;t a form laid over separate products. The backend stores every saved
          definition in one table and every run in another, fires every trigger through one
          dispatcher, and builds every agent&apos;s environment the same way. One{" "}
          <code className="font-mono text-[13px] text-text">/api/work</code> serves the web, the
          mobile apps, and the CLI. A capability lands once, and the matrix stays full.
        </p>
        <div className="mt-8">
          <WorkDiagram />
        </div>
        <Shot
          src="/screenshots/work-environment.webp"
          alt="The Where section of the New work form with Environment open: connections, MCP servers, and skills toggled, setup commands, and code review set for this work."
          caption="Where → Environment: the repo's settings are the defaults; this work turns a server off, adds a connection, and asks for a review."
        />

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">
          Wherever you are
        </h2>
        <p className="mt-4 leading-7 text-text-muted">
          Agents work for hours; they need you for seconds. The iOS and Android apps carry the same
          Work list, with push notifications, widgets, and a Live Activity that surface the moment
          an agent asks to be allowed, answered, or merged — so you can check in from anywhere,
          without being tied to a laptop.
        </p>
        <div className="my-10 grid items-center gap-4 sm:grid-cols-[3fr_2fr]">
          <img
            src="/screenshots/mobile-ios-widget.webp"
            alt="The iOS widget: 3 need you, 2 working — Vesper is quiet, api wants a reply, web asks to allow a command."
            loading="lazy"
            className="w-full rounded-2xl"
          />
          <img
            src="/screenshots/mobile-android-widget.webp"
            alt="The Android widget: 2 need you, 2 running, with counts for waiting, recurring, and agents."
            loading="lazy"
            className="w-full rounded-2xl bg-white p-3"
          />
        </div>

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">
          Built for teams
        </h2>
        <p className="mt-4 leading-7 text-text-muted">
          Work belongs to the organization or to one person. Organization work runs on shared
          secrets, model providers, and connections, and anyone in the workspace can run it.
          Personal work runs with your own credentials: the team sees it, only you change it. Roles
          keep viewers read-only, and every kind of work sits in one list.
        </p>
        <Shot
          src="/screenshots/work-list.webp"
          alt="The Work list: persistent agents, a Task with an open PR, scheduled Jobs including a shell command, and finished runs — one status scale."
          caption="One list for agents, PRs, schedules, commands, and runs."
        />

        <div className="mt-16 flex flex-col gap-4 sm:flex-row">
          <Link
            href="/docs/getting-started"
            className="rounded-md bg-primary px-6 py-3 text-center text-[14px] font-semibold text-white hover:bg-primary-hover transition-colors"
          >
            Get started
          </Link>
          <Link
            href="/docs/sessions"
            className="rounded-md border border-border px-6 py-3 text-center text-[14px] font-semibold text-text hover:bg-bg-hover transition-colors"
          >
            Read the docs
          </Link>
        </div>
      </div>
    </article>
  );
}
