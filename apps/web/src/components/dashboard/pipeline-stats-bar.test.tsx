import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PipelineStatsBar } from "./pipeline-stats-bar";

describe("PipelineStatsBar — agents variant", () => {
  afterEach(() => cleanup());

  it("renders the agent stage labels and counts", () => {
    render(
      <PipelineStatsBar
        variant="agents"
        agentStats={{
          total: 9,
          idle: 3,
          queued: 1,
          running: 2,
          paused: 1,
          failed: 1,
          archived: 1,
        }}
      />,
    );

    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("Queue")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();

    const idleLink = screen.getByText("Idle").closest("a");
    expect(idleLink?.getAttribute("href")).toBe("/agents");
  });

  it("renders zeroes when agentStats is null", () => {
    render(<PipelineStatsBar variant="agents" agentStats={null} />);
    // Six stages — all should render even if all-zero
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });
});

describe("PipelineStatsBar — sessions variant", () => {
  afterEach(() => cleanup());

  it("renders Active and Ended (24h) stages", () => {
    render(
      <PipelineStatsBar variant="sessions" sessionStats={{ total: 4, active: 3, ended: 1 }} />,
    );

    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Ended (24h)")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();

    const activeLink = screen.getByText("Active").closest("a");
    expect(activeLink?.getAttribute("href")).toBe("/sessions");
  });

  it("renders zeroes when sessionStats is null", () => {
    render(<PipelineStatsBar variant="sessions" sessionStats={null} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Ended (24h)")).toBeInTheDocument();
  });
});
