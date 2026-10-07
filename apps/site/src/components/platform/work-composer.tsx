"use client";

import { useState } from "react";
import { ANSWERS, type AnswerKey } from "./answers";

type Example = Record<AnswerKey, string> & { title: string; outcome: string };

const EXAMPLES: Example[] = [
  {
    title: "Ship a fix",
    when: "GitHub ticket labeled optio",
    where: "Optio pod · storefront repo",
    who: "OpenAI Codex",
    what: "Reproduce the bug, fix it, and add a regression test.",
    then: "Open a pull request",
    outcome:
      "A labeled ticket becomes a code change you can review. Optio tracks CI and review feedback; automatic review and resuming are configurable.",
  },
  {
    title: "Run a daily briefing",
    when: "Weekdays · 09:00 UTC",
    where: "Optio pod · no repo",
    who: "Google Gemini",
    what: "Summarize open Linear issues and post a briefing to Slack.",
    then: "Exit when done",
    outcome:
      "A recurring workflow starts a fresh run each morning, using the Linear and Slack connections you assign to it.",
  },
  {
    title: "Work on your machine",
    when: "Start now",
    where: "My laptop · ~/src/app",
    who: "Claude Code",
    what: "Help me investigate and improve the slow search endpoint.",
    then: "Wait for me",
    outcome:
      "An interactive session uses your machine’s installed CLI and login. Return to the conversation or terminal from the web or native apps.",
  },
  {
    title: "Keep an agent available",
    when: "Messages and wake triggers",
    where: "Optio pod · docs repo",
    who: "Claude Code",
    what: "Answer codebase questions and keep the team’s docs current.",
    then: "Wait for messages",
    outcome:
      "A named persistent agent works in turns, keeps its context, and can receive messages from people or other agents in its scope.",
  },
  {
    title: "Run a command",
    when: "On a schedule",
    where: "Optio pod · no repo",
    who: "Terminal · shell command",
    what: "Run the reporting script installed by your setup commands.",
    then: "Exit when done",
    outcome:
      "A command workflow needs no agent. Optio captures its output and uses the command’s exit status to settle the run.",
  },
];

export function WorkComposer() {
  const [index, setIndex] = useState(0);
  const example = EXAMPLES[index];

  return (
    <div className="work-examples">
      <div className="example-picker" role="group" aria-label="Choose a workflow example">
        {EXAMPLES.map((item, i) => (
          <button
            key={item.title}
            type="button"
            aria-pressed={i === index}
            aria-controls="workflow-example"
            onClick={() => setIndex(i)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div id="workflow-example" aria-live="polite" aria-atomic="true">
        <dl className="example-answers">
          {ANSWERS.map((answer) => (
            <div key={answer.key}>
              <dt style={{ color: answer.color }}>{answer.name}</dt>
              <dd>{example[answer.key]}</dd>
            </div>
          ))}
        </dl>
        <p className="example-outcome">
          <span>What happens</span>
          {example.outcome}
        </p>
      </div>
    </div>
  );
}
