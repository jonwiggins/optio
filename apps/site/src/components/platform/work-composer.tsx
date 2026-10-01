"use client";

import { useEffect, useState } from "react";
import { ANSWERS, type AnswerKey } from "./answers";

/**
 * The article's animation: five answers, recombined. Every few seconds a
 * different piece of real work is composed from the same five columns, and
 * the sentence the New work form would show updates with it (each one is
 * what `describe()` in apps/web/src/components/work-form/model.ts says for
 * that draft). Hover (or focus) pauses it; the dots pick one. With reduced
 * motion it holds still.
 */

type Example = Record<AnswerKey, string> & { sentence: string };

const EXAMPLES: Example[] = [
  {
    when: "Ticket labeled optio",
    where: "Pod · acme/web",
    who: "OpenAI Codex",
    env: "+ Sentry, review on PR",
    then: "Works until merged",
    sentence:
      "Started by GitHub tickets, an OpenAI Codex run in an Optio pod with acme/web that opens a PR and keeps working on it until it merges.",
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
    who: "Google Gemini",
    env: "+ Linear, Postgres",
    then: "Exits",
    sentence:
      "Started by Slack messages, a Google Gemini run in an Optio pod that exits when done.",
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
        {ANSWERS.map((a, i) => (
          <div key={a.key} className="min-w-0">
            <div
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: a.color }}
            >
              {a.name}
            </div>
            {/* Every example's answer sits in the same grid cell, so the chip is
                as tall as the longest at any width and never jumps; only the
                current one shows, re-keyed so it slides in fresh, staggered. */}
            <div className="mt-2 grid">
              {EXAMPLES.map((e, j) => (
                <div
                  key={`${j}-${j === index}`}
                  aria-hidden={j === index ? undefined : true}
                  className={`${j === index ? "composer-chip" : "invisible"} col-start-1 row-start-1 flex min-h-[3.4rem] items-center rounded-lg border px-3 py-2 text-[13px] leading-snug text-text-heading`}
                  style={{
                    borderColor: `${a.color}55`,
                    background: `${a.color}14`,
                    animationDelay: `${i * 90}ms`,
                  }}
                >
                  {e[a.key]}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* The sentences share one cell too: the box holds the longest. */}
      <div className="mt-5 grid">
        {EXAMPLES.map((e, j) => (
          <p
            key={`${j}-${j === index}`}
            aria-hidden={j === index ? undefined : true}
            className={`${j === index ? "composer-sentence" : "invisible"} col-start-1 row-start-1 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-[14px] leading-6 text-primary-light`}
          >
            {e.sentence}
          </p>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-center gap-1">
        {EXAMPLES.map((e, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Show example ${i + 1}: ${e.when}, ${e.who}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            // A 24px-tall hit area (wider for the current one) around the pill.
            className="flex h-6 items-center justify-center rounded-full"
            style={{ width: i === index ? 34 : 24 }}
          >
            <span
              className="block h-1.5 rounded-full transition-all"
              style={{
                width: i === index ? 22 : 8,
                background: i === index ? "var(--color-primary-light)" : "var(--color-text-muted)",
              }}
            />
          </button>
        ))}
      </div>
    </figure>
  );
}
