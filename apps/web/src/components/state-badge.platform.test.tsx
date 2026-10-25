import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StateBadge, PR_OPEN_HINT } from "./state-badge";
import { featuresFromEnv } from "@optio/shared/features";
import { useFeaturesStore } from "@/hooks/use-features";

afterEach(() => {
  cleanup();
  useFeaturesStore.setState({ features: featuresFromEnv({}) });
});

describe("StateBadge for an open change request", () => {
  it("reads PR by default, and says what it waits on", () => {
    render(<StateBadge state="pr_opened" />);
    const label = screen.getByText("PR");
    expect(label.closest("[title]")).toHaveAttribute("title", PR_OPEN_HINT);
    expect(PR_OPEN_HINT).toBe("Waiting for review or merge");
  });

  it("reads MR for a GitLab merge request, by its URL or the repo's platform", () => {
    const { rerender } = render(
      <StateBadge state="pr_opened" prUrl="https://gitlab.example.com/g/app/-/merge_requests/12" />,
    );
    expect(screen.getByText("MR")).toBeInTheDocument();

    rerender(<StateBadge state="pr_opened" platform="gitlab" />);
    expect(screen.getByText("MR")).toBeInTheDocument();

    rerender(<StateBadge state="pr_opened" prUrl="https://github.com/acme/app/pull/7" />);
    expect(screen.getByText("PR")).toBeInTheDocument();
  });

  it("reads MR with GitLab alone when nothing else says", () => {
    useFeaturesStore.setState({ features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal" }) });
    render(<StateBadge state="pr_opened" />);
    expect(screen.getByText("MR")).toBeInTheDocument();
  });

  it("gives other states no tooltip", () => {
    render(<StateBadge state="running" />);
    expect(screen.getByText("Running").closest("[title]")).toBeNull();
  });
});
