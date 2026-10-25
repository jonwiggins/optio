import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TaskStatus } from "./issues-browser";
import { featuresFromEnv } from "@optio/shared/features";
import { useFeaturesStore } from "@/hooks/use-features";

afterEach(() => {
  cleanup();
  useFeaturesStore.setState({ features: featuresFromEnv({}) });
});

describe("TaskStatus", () => {
  it("says an issue's task opened its PR by default", () => {
    render(<TaskStatus task={{ state: "pr_opened" }} />);
    expect(screen.getByText(/PR open/)).toBeInTheDocument();
  });

  it("says MR open for a GitLab issue's task, or with GitLab alone", () => {
    render(<TaskStatus task={{ state: "pr_opened" }} platform="gitlab" />);
    expect(screen.getByText(/MR open/)).toBeInTheDocument();
    cleanup();

    useFeaturesStore.setState({ features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal" }) });
    render(<TaskStatus task={{ state: "pr_opened" }} />);
    expect(screen.getByText(/MR open/)).toBeInTheDocument();
  });

  it("keeps the other states' words", () => {
    render(<TaskStatus task={{ state: "running" }} />);
    expect(screen.getByText(/Running/)).toBeInTheDocument();
  });
});
