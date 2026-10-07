import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Bot, Clock, Terminal, Ticket, Webhook } from "lucide-react";
import {
  AgentIcon,
  BrandIcon,
  agentRuntimeIcon,
  PrIcon,
  TriggerIcon,
  brandFor,
  prStateOf,
  triggerLabel,
  triggerTypeIcon,
} from "./brand-icon";

describe("brand-icon", () => {
  it("maps provider strings to brands, ignoring unknowns and prototype keys", () => {
    expect(brandFor("GitHub")).toBe("github");
    expect(brandFor("linear")).toBe("linear");
    expect(brandFor("codecommit")).toBeNull();
    expect(brandFor("toString")).toBeNull();
    expect(brandFor(null)).toBeNull();
  });

  it("has a single-path mark for every connection and trigger brand", () => {
    for (const b of [
      "aws",
      "pagerduty",
      "postgresql",
      "pylon",
      "datadog",
      "alertmanager",
    ] as const) {
      expect(brandFor(b)).toBe(b);
      const { container } = render(<BrandIcon brand={b} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.querySelectorAll("path")).toHaveLength(1);
      expect(svg.querySelector("path")!.getAttribute("d")).toMatch(/^[Mm]/);
    }
    expect(brandFor("postgres")).toBeNull();
  });

  it("uses brand marks for event triggers and lucide icons for the generic ones", () => {
    expect(triggerTypeIcon("schedule")).toBe(Clock);
    expect(triggerTypeIcon("webhook")).toBe(Webhook);
    expect(triggerTypeIcon("ticket")).toBe(Ticket);
    expect(triggerTypeIcon("github")).toBe(triggerTypeIcon("ticket", "github"));
    expect(triggerTypeIcon("slack")).not.toBe(Webhook);
    // The newer event sources resolve through brandFor like the first three.
    expect(triggerTypeIcon("pylon")).toBe(triggerTypeIcon("ticket", "pylon"));
    expect(triggerTypeIcon("pagerduty")).toBe(triggerTypeIcon("ticket", "pagerduty"));
    expect(triggerTypeIcon("gitlab")).toBe(triggerTypeIcon("ticket", "gitlab"));
    expect(triggerTypeIcon("jira")).toBe(triggerTypeIcon("ticket", "jira"));
    for (const t of ["pylon", "pagerduty", "gitlab", "jira", "sentry", "alertmanager", "datadog"]) {
      const Icon = triggerTypeIcon(t);
      expect(Icon).not.toBe(Webhook);
      const { container } = render(<TriggerIcon type={t} />);
      expect(container.querySelector("svg path")).not.toBeNull();
    }
  });

  it("maps agent types to their marks, Terminal for the terminal, Bot otherwise", () => {
    expect(agentRuntimeIcon("")).toBe(Terminal);
    expect(agentRuntimeIcon("terminal")).toBe(Terminal);
    expect(agentRuntimeIcon("openclaw")).toBe(Bot);
    expect(agentRuntimeIcon("toString")).toBe(Bot);
    for (const r of ["claude-code", "codex", "copilot", "gemini", "cursor", "opencode"]) {
      expect(agentRuntimeIcon(r)).not.toBe(Bot);
    }
    // Every mark is drawn in currentColor: no brand fills.
    const { container } = render(<AgentIcon runtime="claude-code" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("path")!.getAttribute("fill")).toBeNull();
  });

  it("labels triggers by their source", () => {
    expect(triggerLabel("github")).toBe("GitHub");
    expect(triggerLabel("ticket", "linear")).toBe("Linear ticket");
    expect(triggerLabel("ticket")).toBe("ticket");
    expect(triggerLabel("schedule")).toBe("schedule");
    expect(triggerLabel("pylon")).toBe("Pylon");
    expect(triggerLabel("pagerduty")).toBe("PagerDuty");
    expect(triggerLabel("gitlab")).toBe("GitLab");
    expect(triggerLabel("jira")).toBe("Jira");
    expect(triggerLabel("sentry")).toBe("Sentry");
    expect(triggerLabel("alertmanager")).toBe("Alertmanager");
    expect(triggerLabel("datadog")).toBe("Datadog");
    expect(triggerLabel("ticket", "gitlab")).toBe("GitLab ticket");
  });

  it("normalizes PR states and tints them", () => {
    expect(prStateOf("MERGED")).toBe("merged");
    expect(prStateOf(undefined)).toBe("open");
    const { container } = render(<PrIcon state="closed" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("text-error");
  });

  it("marks are decorative unless titled", () => {
    const { container } = render(<BrandIcon brand="slack" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("path")).toHaveLength(4);
    const titled = render(<BrandIcon brand="github" title="GitHub" />).container.querySelector(
      "svg",
    )!;
    expect(titled.getAttribute("aria-hidden")).toBeNull();
    expect(titled.getAttribute("role")).toBe("img");
  });
});
