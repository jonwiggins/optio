"use client";

import { useEffect, useState } from "react";

/**
 * The article's animation: five answers, recombined. Every few seconds a
 * different piece of real work is composed from the same five columns, and
 * the sentence the New work form would show updates with it. Hover (or
 * focus) pauses it; the dots pick one. With reduced motion it holds still.
 */

const ATTRIBUTES = [
  { key: "when", label: "When", color: "#a78bfa" },
  { key: "where", label: "Where", color: "#60a5fa" },
  { key: "who", label: "Who", color: "#f0a040" },
  { key: "env", label: "Environment", color: "#818cf8" },
  { key: "then", label: "Then", color: "#34d399" },
] as const;

type Example = Record<(typeof ATTRIBUTES)[number]["key"], string> & { sentence: string };

const EXAMPLES: Example[] = [
  {
    when: "Ticket labeled optio",
    where: "Pod · acme/web",
    who: "Codex",
    env: "+ Sentry, review on PR",
    then: "Works until merged",
    sentence:
      "Started by GitHub tickets, a Codex run in an Optio pod with acme/web that opens a PR and keeps working on it until it merges.",
  },
  {
    when: "Weekdays 09:00",
    where: "Pod · no repo",
    who: "Shell command",
    env: "+ NPM_TOKEN",
    then: "Exits",
    sentence: "Running weekdays at 09:00 UTC, a command in an Optio pod that runs and exits.",
  },
  {
    when: "Review requested",
    where: "My laptop · new branch",
    who: "Claude Code",
    env: "Machine's own CLI",
    then: "Waits for me",
    sentence:
      "Started by GitHub events, a Claude Code session on my laptop on a new branch in ~/src/app that waits for you between turns.",
  },
  {
    when: "Messages",
    where: "Pod · acme/docs",
    who: "Claude Code",
    env: "+ Notion, docs-search",
    then: "Persistent agent",
    sentence:
      "Woken by messages, a Claude Code agent in an Optio pod with acme/docs that keeps its memory between turns.",
  },
  {
    when: "Slack mention",
    where: "Pod · no repo",
    who: "Gemini",
    env: "+ Linear, Postgres",
    then: "Exits",
    sentence: "Started by Slack events, a Gemini run in an Optio pod that exits when done.",
  },
];

const INTERVAL_MS = 3600;

export function WorkComposer() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (paused || still) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % EXAMPLES.length), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [paused]);

  const example = EXAMPLES[index];
  return (
    <figure
      className="rounded-2xl border border-border bg-bg-card p-5 sm:p-7"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      aria-label="Five answers compose a piece of work"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {ATTRIBUTES.map((a, i) => (
          <div key={a.key} className="min-w-0">
            <div
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: a.color }}
            >
              {a.label}
            </div>
            <div
              // Re-keyed per example so each answer slides in fresh, staggered.
              key={`${index}-${a.key}`}
              className="composer-chip mt-2 flex min-h-[3.4rem] items-center rounded-lg border px-3 py-2 text-[13px] leading-snug text-text-heading"
              style={{
                borderColor: `${a.color}55`,
                background: `${a.color}14`,
                animationDelay: `${i * 90}ms`,
              }}
            >
              {example[a.key]}
            </div>
          </div>
        ))}
      </div>
      <figcaption
        key={`s-${index}`}
        className="composer-sentence mt-5 min-h-[4.6rem] rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-[14px] leading-6 text-primary-light"
      >
        {example.sentence}
      </figcaption>
      <div className="mt-4 flex items-center justify-center gap-2">
        {EXAMPLES.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Example ${i + 1}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            className="h-1.5 rounded-full transition-all"
            style={{
              width: i === index ? 22 : 8,
              background: i === index ? "var(--color-primary-light)" : "var(--color-border-strong)",
            }}
          />
        ))}
      </div>
    </figure>
  );
}
