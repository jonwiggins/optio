import { featuresFromEnv } from "@optio/shared/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ChecklistSources } from "./getting-started-model";

// The welcome screen's static Get started steps and the getting-started
// checklist (getting-started.tsx), as the Overview hands it over with the
// guide on: the steps hide only while the checklist shows, so a hidden or
// complete checklist never leaves the welcome empty.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({ teams: true, onboarding: true, loaded: true }),
}));
// GitLab alone through a gateway, or (`defaults`) the default deployment.
const deployment = vi.hoisted(() => ({ defaults: false }));
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({
    features: deployment.defaults
      ? featuresFromEnv({})
      : featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    gatewayOnly: !deployment.defaults,
    loaded: true,
  }),
}));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", email: "ann@example.com", provider: "oidc" },
    authDisabled: false,
    loaded: true,
    isAdmin: true,
    isViewer: false,
  }),
}));
vi.mock("@/lib/api-client", () => ({ api: {} }));
vi.mock("@/lib/credential-health-api", () => ({ credentialHealthApi: {} }));
vi.mock("@/lib/notify-api", () => ({ notifyApi: {} }));

import { WelcomeHero } from "./welcome-hero";
import { GettingStarted } from "./getting-started";
import { useGettingStartedStore } from "./getting-started-store";

const sources = (over: Partial<ChecklistSources> = {}): ChecklistSources => ({
  user: { id: "u1", email: "ann@example.com", provider: "oidc" },
  gateway: {
    gateway: {
      id: "g1",
      name: "LiteLLM",
      baseUrl: "https://litellm.example.com",
      authHeader: "bearer",
      tokenSource: "personal",
      secretName: "ANTHROPIC_AUTH_TOKEN",
    },
    hasToken: false,
    keyInfo: null,
    teams: [],
    orgHasToken: true,
  },
  health: [],
  teams: [],
  repoCount: 0,
  tasks: { started: null, waiting: null, merged: null },
  channels: {
    kinds: [],
    choices: { email: { "task.failed": true }, push: {}, teamWork: true },
    email: { available: true, address: "ann@example.com" },
    push: { available: false },
  },
  ...over,
});

/** As app/page.tsx hands it over on a first run. */
const hero = (load: () => Promise<ChecklistSources>) => (
  <WelcomeHero
    repoCount={0}
    checklist={(onShowing) => <GettingStarted load={load} onShowingChange={onShowing} />}
  />
);
const staticSteps = () => screen.getByText("Get started").closest("div");

beforeEach(() => {
  deployment.defaults = false;
  window.localStorage.clear();
  useGettingStartedStore.setState({ hidden: {} });
});
afterEach(() => cleanup());

describe("WelcomeHero and the first-run checklist", () => {
  it("the checklist shows in place of the static steps", async () => {
    render(hero(async () => sources()));
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
    expect(staticSteps()).toHaveAttribute("hidden");
  });

  it("while the checklist loads, the static steps don't flash in", async () => {
    render(hero(() => new Promise<ChecklistSources>(() => {})));
    await act(async () => {});
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(staticSteps()).toHaveAttribute("hidden");
  });

  it("a person who hid the checklist gets the static steps (Add a repository) back", async () => {
    window.localStorage.setItem("optio.gettingStarted.hidden.u1", "dismissed");
    const load = vi.fn(async () => sources());
    render(hero(load));
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(staticSteps()).not.toHaveAttribute("hidden");
    expect(screen.getByText("Add a repository")).toBeInTheDocument();
  });

  it("a complete checklist shows nothing, so the static steps come back", async () => {
    const done = sources({
      repoCount: 1,
      gateway: {
        ...sources().gateway!,
        hasToken: true,
        keyInfo: { spend: 0, maxBudget: null, budgetResetAt: null, keyAlias: null },
      },
      tasks: {
        started: { id: "a", title: "A" },
        waiting: null,
        merged: { id: "a", title: "A", prUrl: "https://gitlab.example.com/p/-/merge_requests/1" },
      },
    });
    render(hero(async () => done));
    await act(async () => {});
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(staticSteps()).not.toHaveAttribute("hidden");
  });

  it("Hide on the welcome screen brings the static steps back at once", async () => {
    render(hero(async () => sources()));
    const hide = await screen.findByRole("button", { name: /Hide/ });
    expect(staticSteps()).toHaveAttribute("hidden");
    act(() => hide.click());
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(staticSteps()).not.toHaveAttribute("hidden");
  });

  it("without a checklist (sign-in off), its steps are as before", () => {
    render(<WelcomeHero repoCount={0} />);
    expect(staticSteps()).not.toHaveAttribute("hidden");
  });

  it("without a checklist (the guide off) by default, it is the default welcome", () => {
    deployment.defaults = true;
    render(<WelcomeHero repoCount={0} />);
    expect(staticSteps()).not.toHaveAttribute("hidden");
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(
      screen.getByText("Add your Anthropic API key or connect Claude Max credentials."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Connect a GitHub repo so Optio can clone it and run agents."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Submit tasks from the dashboard or GitHub/)).toBeInTheDocument();
  });
});
