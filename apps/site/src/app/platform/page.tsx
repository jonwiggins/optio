import type { Metadata } from "next";
import Link from "next/link";
import { WorkComposer } from "@/components/platform/work-composer";
import { WorkDiagram } from "@/components/platform/work-diagram";
import { ANSWERS } from "@/components/platform/answers";

export const metadata: Metadata = {
  title: "One noun: Work — Optio's approach to an AI platform",
  description:
    "Optio composes AI work from a prompt and five answers — When, Where, Who, Environment, and Then — and nearly any answer combines with any other. One model of work in the backend, on the web, and on your phone.",
};

function Shot({
  src,
  alt,
  caption,
  width,
  height,
}: {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
}) {
  return (
    <figure className="my-10">
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        className="h-auto w-full rounded-xl border border-border shadow-2xl shadow-black/40"
      />
      <figcaption className="mt-3 text-center text-[13px] text-text-muted">{caption}</figcaption>
    </figure>
  );
}

/** A phone widget on a soft, home-screen-like backdrop, the same for both platforms. */
function Widget({
  src,
  alt,
  width,
  height,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
}) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-border p-4 sm:p-5"
      style={{
        background:
          "linear-gradient(140deg, rgba(109, 40, 217, 0.22), rgba(96, 165, 250, 0.12)), var(--color-bg-card)",
      }}
    >
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        className="h-auto w-full"
      />
    </div>
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
          grammar. Every piece of work is a prompt plus five answers, and nearly any answer combines
          with any other — a new trigger starts every kind of saved work, and a new runtime runs
          Tasks, Jobs, and agents alike.
        </p>

        <div className="mt-10">
          <WorkComposer />
        </div>

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">Five answers</h2>
        <ul className="mt-6 space-y-3">
          {ANSWERS.map((a) => (
            <li key={a.key} className="flex gap-3 leading-7 text-text">
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
          What stays apart is what doesn&apos;t make sense: following a PR to merge needs an agent
          and a repo, a persistent agent lives in a pod, and a pod terminal is one you open
          yourself.
        </p>

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">
          One model, all the way down
        </h2>
        <p className="mt-4 leading-7 text-text-muted">
          The answers aren&apos;t a form over separate products. The backend keeps saved Tasks,
          Jobs, and automations in one table and Task and Job runs in another, fires every trigger
          through one dispatcher, and builds every Task&apos;s, Job&apos;s, review&apos;s, and
          agent&apos;s pod environment one way. The web reads it all through{" "}
          <code className="font-mono text-[13px] text-text">/api/work</code>; the iOS and Android
          apps and the CLI read the same rows. A capability lands once, and the matrix stays full.
        </p>
        <div className="mt-8">
          <WorkDiagram />
        </div>
        <Shot
          src="/screenshots/work-environment.webp"
          width={1436}
          height={1668}
          alt="The Where section of the New work form with Environment open: connections, MCP servers, and skills toggled, setup commands, and code review set for this work."
          caption="Where → Environment: the repo's settings are the defaults; this work turns a server off, adds a connection, and asks for a review."
        />

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">
          Wherever you are
        </h2>
        <p className="mt-4 leading-7 text-text-muted">
          Agents work for hours; they need you for seconds. The iOS and Android apps carry the same
          Work list, with notifications, home-screen widgets, and a live status (a Live Activity on
          iPhone, an ongoing notification on Android). When an agent asks to be allowed, answered,
          or merged, you check in from wherever you are — no computer needed.
        </p>
        <div className="my-10 grid items-stretch gap-4 sm:grid-cols-2">
          <Widget
            src="/screenshots/mobile-ios-widget.webp"
            width={676}
            height={316}
            alt="The iOS widget: 3 need you, 2 working — Vesper is quiet, api wants a reply, web asks to allow a command."
          />
          <Widget
            src="/screenshots/mobile-android-widget.webp"
            width={477}
            height={223}
            alt="The Android widget: 2 need you, 2 running, with counts for waiting, recurring, and agents."
          />
        </div>

        <h2 className="mt-16 text-2xl font-bold tracking-tight text-text-heading">
          Built for teams
        </h2>
        <p className="mt-4 leading-7 text-text-muted">
          Work belongs to the organization or to one person. Organization work runs on shared
          secrets, model providers, and connections, and any member can run it. Personal work runs
          with your own credentials: the team sees it; only you change or run it. Viewers stay
          read-only.
        </p>
        <Shot
          src="/screenshots/work-list.webp"
          width={1536}
          height={1189}
          alt="The Work list: Tasks with open PRs, two persistent agents, a scheduled Task and Jobs started by a ticket, Slack, and schedules — one a shell command — and finished runs, on one status scale."
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
