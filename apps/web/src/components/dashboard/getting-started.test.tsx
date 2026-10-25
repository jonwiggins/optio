import { featuresFromEnv } from "@optio/shared/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GatewayMe } from "@/lib/api-client";
import type { ChecklistSources } from "./getting-started-model";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({
  currentUser: {} as any,
  teams: false,
  api: {
    getMyGateway: vi.fn(),
    listTeams: vi.fn(),
    listRepos: vi.fn(),
    searchTasks: vi.fn(),
  },
  credentialHealthApi: { list: vi.fn() },
  notifyApi: { getMyChannels: vi.fn() },
}));
const { api, credentialHealthApi, notifyApi } = mocks;
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({ teams: mocks.teams, onboarding: true, loaded: true }),
}));
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({
    features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    gatewayOnly: true,
    loaded: true,
  }),
}));
vi.mock("@/lib/api-client", () => ({ api: mocks.api }));
vi.mock("@/lib/credential-health-api", () => ({ credentialHealthApi: mocks.credentialHealthApi }));
vi.mock("@/lib/notify-api", () => ({ notifyApi: mocks.notifyApi }));

import { GettingStarted, loadChecklistSources } from "./getting-started";
import { useGettingStartedStore } from "./getting-started-store";

const GW: GatewayMe = {
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
};

const sources = (over: Partial<ChecklistSources> = {}): ChecklistSources => ({
  user: { id: "u1", email: "carol@example.com", provider: "ldap" },
  gateway: GW,
  health: [],
  teams: [],
  repoCount: 1,
  tasks: { started: null, waiting: null, merged: null },
  channels: {
    kinds: [],
    choices: { email: { "task.failed": true }, push: {}, teamWork: true },
    email: { available: true, address: "carol@example.com" },
    push: { available: false },
  },
  ...over,
});

const KEY = "optio.gettingStarted.hidden.u1";

beforeEach(() => {
  window.localStorage.clear();
  useGettingStartedStore.setState({ hidden: {} });
  mocks.teams = false;
  mocks.currentUser = {
    user: { id: "u1", email: "carol@example.com", provider: "ldap" },
    authDisabled: false,
    isAdmin: false,
    isViewer: false,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GettingStarted (the Overview's getting-started checklist)", () => {
  it("has no team step, and asks for no teams, while teams are off", async () => {
    const load = vi.fn(async () => sources());
    render(<GettingStarted load={load} />);
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(expect.anything(), { isViewer: false, teams: false });
    expect(screen.queryByTestId("getting-started-team")).not.toBeInTheDocument();
  });

  it("offers joining a team with teams on", async () => {
    mocks.teams = true;
    const load = vi.fn(async () => sources());
    render(<GettingStarted load={load} />);
    expect(await screen.findByTestId("getting-started-team")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(expect.anything(), { isViewer: false, teams: true });
  });

  it("shows each step's real state, with links to where it's done", async () => {
    render(<GettingStarted load={async () => sources()} />);
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
    expect(screen.getByTestId("getting-started-sign-in")).toHaveAttribute("data-state", "done");
    const token = screen.getByTestId("getting-started-gateway-token");
    expect(token).toHaveAttribute("data-state", "todo");
    expect(token).toHaveTextContent("Add your gateway token");
    expect(screen.getByRole("link", { name: /Add token/ })).toHaveAttribute(
      "href",
      "/settings#my-tokens",
    );
    expect(screen.getByRole("link", { name: /New work/ })).toHaveAttribute("href", "/work/new");
    // sign-in, repo, notifications of six counted steps
    expect(screen.getByText(/3 of 6 done/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByRole("link", { name: /Using Optio, the guide/ })).toHaveAttribute(
      "href",
      "/help",
    );
  });

  it("the token step is checked once the person has a token the gateway takes", async () => {
    render(
      <GettingStarted
        load={async () =>
          sources({
            gateway: {
              ...GW,
              hasToken: true,
              keyInfo: { spend: 0, maxBudget: 5, budgetResetAt: null, keyAlias: "carol" },
            },
          })
        }
      />,
    );
    const token = await screen.findByTestId("getting-started-gateway-token");
    expect(token).toHaveAttribute("data-state", "done");
    expect(token).toHaveTextContent("Stored, and LiteLLM accepts it.");
  });

  it("Hide puts it away for this person, and remembers it", async () => {
    render(<GettingStarted load={async () => sources()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Hide/ }));
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe("dismissed");

    // Next visit: nothing is fetched while it's hidden.
    cleanup();
    useGettingStartedStore.setState({ hidden: {} });
    const load = vi.fn(async () => sources());
    render(<GettingStarted load={load} />);
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();

    // Help → Getting-started checklist brings it back.
    act(() => useGettingStartedStore.getState().show("u1"));
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("another person on the same browser still gets theirs", async () => {
    window.localStorage.setItem("optio.gettingStarted.hidden.someone-else", "dismissed");
    render(<GettingStarted load={async () => sources()} />);
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
  });

  it("goes away once every step is done, and isn't fetched again", async () => {
    const done = sources({
      gateway: {
        ...GW,
        hasToken: true,
        keyInfo: { spend: 0, maxBudget: null, budgetResetAt: null, keyAlias: null },
      },
      tasks: {
        started: { id: "a", title: "A" },
        waiting: null,
        merged: { id: "a", title: "A", prUrl: "https://gitlab.example.com/p/-/merge_requests/1" },
      },
    });
    render(<GettingStarted load={async () => done} />);
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBe("complete"));
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
  });

  it("complete only for now is shown no more this visit, but not remembered", async () => {
    // A viewer: sign-in and email are all their steps, until they become a member.
    mocks.currentUser = { ...mocks.currentUser, isViewer: true };
    const load = vi.fn(async () => sources({ gateway: null, health: null, tasks: null }));
    render(<GettingStarted load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    cleanup();

    // A member whose email request failed: the step was left out, not done.
    mocks.currentUser = { ...mocks.currentUser, isViewer: false };
    const allButEmail = vi.fn(async () =>
      sources({
        gateway: {
          ...GW,
          hasToken: true,
          keyInfo: { spend: 0, maxBudget: null, budgetResetAt: null, keyAlias: null },
        },
        tasks: {
          started: { id: "a", title: "A" },
          waiting: null,
          merged: { id: "a", title: "A", prUrl: "https://gitlab.example.com/p/-/merge_requests/1" },
        },
        channels: null,
      }),
    );
    render(<GettingStarted load={allButEmail} />);
    await waitFor(() => expect(allButEmail).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    cleanup();

    // So the next visit asks again, and finds what changed.
    render(<GettingStarted load={async () => sources()} />);
    expect(await screen.findByTestId("getting-started")).toBeInTheDocument();
  });

  it("a token over its budget needs a fix, though the gateway answers for it", async () => {
    render(
      <GettingStarted
        load={async () =>
          sources({
            gateway: {
              ...GW,
              hasToken: true,
              keyInfo: { spend: 6, maxBudget: 5, budgetResetAt: null, keyAlias: "carol" },
            },
          })
        }
      />,
    );
    const token = await screen.findByTestId("getting-started-gateway-token");
    expect(token).toHaveAttribute("data-state", "attention");
    expect(token).toHaveTextContent("Your gateway token is over its budget");
  });

  it("says whether it shows: loading and showing yes, hidden no", async () => {
    const onShowing = vi.fn();
    render(<GettingStarted load={async () => sources()} onShowingChange={onShowing} />);
    expect(onShowing).toHaveBeenLastCalledWith(true);
    fireEvent.click(await screen.findByRole("button", { name: /Hide/ }));
    expect(onShowing).toHaveBeenLastCalledWith(false);
  });

  it("shows nothing with sign-in off (no person to keep it for)", async () => {
    mocks.currentUser = { user: null, authDisabled: true, isAdmin: true, isViewer: false };
    const load = vi.fn(async () => sources());
    render(<GettingStarted load={load} />);
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("getting-started")).not.toBeInTheDocument();
  });
});

describe("loadChecklistSources", () => {
  beforeEach(() => {
    api.getMyGateway.mockResolvedValue(GW);
    credentialHealthApi.list.mockResolvedValue({ rows: [], canCheckAll: false });
    api.listTeams.mockResolvedValue({ teams: [] });
    api.listRepos.mockResolvedValue({ repos: [{ id: "r1" }, { id: "r2" }] });
    api.searchTasks.mockImplementation(async ({ state }: { state?: string }) => ({
      tasks:
        state === "completed"
          ? [{ id: "m", title: "Merged", prUrl: "https://gitlab.example.com/p/-/merge_requests/2" }]
          : state === "pr_opened"
            ? []
            : [{ id: "s", title: "Started" }],
    }));
    notifyApi.getMyChannels.mockResolvedValue(sources().channels);
  });

  it("reads the existing APIs: the person's own tasks, their token's health, teams, repos, email", async () => {
    const got = await loadChecklistSources(
      { id: "u1", email: "carol@example.com" },
      { isViewer: false },
    );
    expect(api.searchTasks).toHaveBeenCalledWith({ author: "u1", taskType: "coding", limit: 1 });
    expect(api.searchTasks).toHaveBeenCalledWith({
      author: "u1",
      taskType: "coding",
      state: "pr_opened",
      limit: 1,
    });
    expect(credentialHealthApi.list).toHaveBeenCalledWith(true);
    expect(got.repoCount).toBe(2);
    expect(got.tasks).toEqual({
      started: { id: "s", title: "Started", prUrl: null },
      waiting: null,
      merged: {
        id: "m",
        title: "Merged",
        prUrl: "https://gitlab.example.com/p/-/merge_requests/2",
      },
    });
  });

  it("a failed request leaves its source null instead of failing the checklist", async () => {
    api.getMyGateway.mockRejectedValue(new Error("502"));
    api.listTeams.mockRejectedValue(new Error("500"));
    const got = await loadChecklistSources(
      { id: "u1", email: "carol@example.com" },
      { isViewer: false },
    );
    expect(got.gateway).toBeNull();
    expect(got.teams).toBeNull();
    expect(got.repoCount).toBe(2);
  });

  it("asks for no teams while teams are off", async () => {
    const got = await loadChecklistSources(
      { id: "u1", email: "carol@example.com" },
      { isViewer: false },
    );
    expect(api.listTeams).not.toHaveBeenCalled();
    expect(got.teams).toBeNull();
  });

  it("reads the repos' platforms for the checklist's words", async () => {
    api.listRepos.mockResolvedValue({
      repos: [
        { id: "r1", gitPlatform: "gitlab" },
        { id: "r2", gitPlatform: "gitlab" },
      ],
    });
    const got = await loadChecklistSources(
      { id: "u1", email: "carol@example.com" },
      { isViewer: false },
    );
    expect(got.repoCount).toBe(2);
    expect(got.repoPlatforms).toEqual(["gitlab", "gitlab"]);
  });

  it("a viewer's checklist asks only for teams (with teams on) and email", async () => {
    await loadChecklistSources(
      { id: "u1", email: "v@example.com" },
      { isViewer: true, teams: true },
    );
    expect(api.getMyGateway).not.toHaveBeenCalled();
    expect(api.searchTasks).not.toHaveBeenCalled();
    expect(api.listRepos).not.toHaveBeenCalled();
    expect(api.listTeams).toHaveBeenCalled();
    expect(notifyApi.getMyChannels).toHaveBeenCalled();
  });
});
