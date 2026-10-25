import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ onboarding: false, loaded: true }));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: vi.fn() }));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({ onboarding: mocks.onboarding, loaded: mocks.loaded }),
}));
vi.mock("@/components/help/guide-markdown", () => ({
  GuideMarkdown: ({ source }: { source: string }) => (
    <div data-testid="guide">{source.slice(0, 40)}</div>
  ),
}));

import HelpPage from "./page";

afterEach(() => {
  cleanup();
  mocks.onboarding = false;
  mocks.loaded = true;
});

describe("/help", () => {
  it("says the guide is off by default, and where an admin turns it on", () => {
    render(<HelpPage />);
    expect(screen.getByText("The guide is off")).toBeInTheDocument();
    expect(screen.getByText(/Settings → Access → Getting-started guide/)).toBeInTheDocument();
    expect(screen.queryByTestId("guide")).toBeNull();
  });

  it("shows the guide with the getting-started guide on", () => {
    mocks.onboarding = true;
    render(<HelpPage />);
    expect(screen.getByTestId("guide")).toBeInTheDocument();
    expect(screen.queryByText("The guide is off")).toBeNull();
  });

  it("shows neither until the switches are known", () => {
    mocks.loaded = false;
    render(<HelpPage />);
    expect(screen.queryByTestId("guide")).toBeNull();
    expect(screen.queryByText("The guide is off")).toBeNull();
  });
});
