import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { PipelineTimeline } from "./pipeline-timeline";

afterEach(() => {
  cleanup();
  features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
});

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
const events = [
  { id: "1", toState: "queued", createdAt: at(0) },
  { id: "2", toState: "provisioning", createdAt: at(1) },
  { id: "3", toState: "running", createdAt: at(2) },
  { id: "4", toState: "pr_opened", createdAt: at(3) },
];

describe("PipelineTimeline", () => {
  it("names an open merge request's stage MR, with its !number", () => {
    const task = {
      state: "pr_opened",
      prNumber: 12,
      prUrl: "https://gitlab.example.com/group/app/-/merge_requests/12",
      prChecksStatus: "none",
    };
    render(<PipelineTimeline task={task} events={events} subtasks={[]} />);
    expect(screen.getByText("MR")).toBeInTheDocument();
    expect(screen.getByText("!12")).toBeInTheDocument();
    expect(screen.queryByText("PR")).toBeNull();
  });

  it("names an open pull request's stage PR by default", () => {
    features = featuresFromEnv({});
    const task = {
      state: "pr_opened",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      prChecksStatus: "none",
    };
    render(<PipelineTimeline task={task} events={events} subtasks={[]} />);
    expect(screen.getByText("PR")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
  });

  it("names the stage MR before it opens with GitLab alone, PR by default", () => {
    const task = { state: "running" };
    render(<PipelineTimeline task={task} events={events.slice(0, 3)} subtasks={[]} />);
    expect(screen.getByText("MR")).toBeInTheDocument();
    cleanup();

    features = featuresFromEnv({});
    render(<PipelineTimeline task={task} events={events.slice(0, 3)} subtasks={[]} />);
    expect(screen.getByText("PR")).toBeInTheDocument();
  });

  it("keeps the stage's name once the run moved past it", () => {
    const task = {
      state: "completed",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      prState: "merged",
    };
    render(
      <PipelineTimeline
        task={task}
        events={[...events, { id: "5", toState: "completed", createdAt: at(4) }]}
        subtasks={[]}
      />,
    );
    expect(screen.getByText("PR")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
  });
});
