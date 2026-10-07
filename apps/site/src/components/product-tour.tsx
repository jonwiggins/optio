"use client";

import { useRef, useState } from "react";

const slides = [
  {
    id: "work",
    label: "Work",
    title: "A home for every kind of work.",
    text: "Keep one-off tasks, recurring automations, local sessions, and persistent agents in the same feed. See what is running, what finished, and what needs you.",
    image: "web-work",
    alt: "Optio Work feed with scheduled, GitHub, Linear, ticket, Slack, and PagerDuty example workflows",
  },
  {
    id: "compose",
    label: "Build a workflow",
    title: "Five answers. A workflow that fits.",
    text: "Choose When, Where, Who, What, and Then. Start with the trigger, choose a pod or your machine, and pick the agent and prompt. A plain-language summary tells you what will happen.",
    image: "web-new-work",
    alt: "Work editor with schedule and location settings and a summary of a Codex dependency update workflow",
  },
  {
    id: "sessions",
    label: "Sessions",
    title: "Stay close to the work.",
    text: "Read the conversation, use the terminal, or open a shell in the same directory. Split sessions side by side and resize the session list. Your pane arrangement stays on this device.",
    image: "web-sessions",
    alt: "Claude Code conversation and a terminal side by side with nested sessions in the sidebar",
  },
  {
    id: "agents",
    label: "Persistent agents",
    title: "Give your team a team of agents.",
    text: "Create named specialists with their own instructions and inboxes. They can wake on messages, work together through the inter-agent API, and wait between turns.",
    image: "web-agents",
    alt: "Persistent agents list showing an engineering coordinator, codebase researcher, and release reviewer",
  },
  {
    id: "history",
    label: "Run history",
    title: "Keep the outcome, not just the output.",
    text: "Follow a run through its logs and results. Track PRs, review feedback, and costs where available, then return to the work when you need the context again.",
    image: "web-history",
    alt: "Completed example repo tasks and job runs in Optio's Work history",
  },
];

export function ProductTour() {
  const [active, setActive] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div>
      <div role="tablist" aria-label="Product tour" className="tour-tabs">
        {slides.map((item, index) => (
          <button
            key={item.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`tour-tab-${item.id}`}
            aria-selected={active === index}
            aria-controls={`tour-panel-${item.id}`}
            tabIndex={active === index ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (active + 1) % slides.length;
              else if (event.key === "ArrowLeft")
                next = (active + slides.length - 1) % slides.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = slides.length - 1;
              else return;
              event.preventDefault();
              setActive(next);
              buttons.current[next]?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {slides.map((slide, index) => (
        <div
          key={slide.id}
          hidden={active !== index}
          role="tabpanel"
          id={`tour-panel-${slide.id}`}
          aria-labelledby={`tour-tab-${slide.id}`}
          tabIndex={0}
          className="tour-panel"
        >
          <div className="tour-copy">
            <h3>{slide.title}</h3>
            <p>{slide.text}</p>
          </div>
          <a
            href={`/screenshots/showcase/${slide.image}.webp`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open full-size screenshot: ${slide.label}`}
            className="product-image"
          >
            {/* Static export: screenshots have already been optimized to WebP. */}
            <img
              src={`/screenshots/showcase/${slide.image}.webp`}
              alt={slide.alt}
              width={1440}
              height={1000}
              loading="lazy"
            />
            <span className="image-hint">View full size ↗</span>
          </a>
        </div>
      ))}
      <p className="sample-note">
        Real Optio screens with fictional example data. Activity and usage in this tour are
        simulated.
      </p>
    </div>
  );
}
