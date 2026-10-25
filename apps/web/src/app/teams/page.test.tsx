import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Team } from "@optio/shared";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/teams",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: vi.fn() }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", displayName: "Jon" },
    userId: "u1",
    isAdmin: false,
    isViewer: false,
    canMutate: true,
    loaded: true,
    authDisabled: false,
    isDeploymentAdmin: false,
    teamIds: [],
    adminTeamIds: [],
  }),
}));

const listTeams = vi.fn();
const createTeam = vi.fn();
const joinTeam = vi.fn();
const leaveTeam = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    listTeams: () => listTeams(),
    createTeam: (...a: unknown[]) => createTeam(...a),
    joinTeam: (...a: unknown[]) => joinTeam(...a),
    leaveTeam: (...a: unknown[]) => leaveTeam(...a),
  },
}));

import TeamsPage from "./page";
import { useMyTeamsStore } from "@/hooks/use-my-teams";
import { useDeploymentSwitchesStore } from "@/hooks/use-deployment-switches";

const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "66666666-7777-4888-9999-000000000000";

function team(over: Partial<Team>): Team {
  return {
    id: T1,
    workspaceId: "ws",
    name: "Platform",
    slug: "platform",
    description: null,
    joinPolicy: "open",
    createdBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    memberCount: 3,
    pendingCount: 0,
    myRole: null,
    myStatus: null,
    canManage: false,
    ...over,
  };
}

beforeAll(() => {
  // jsdom has no <dialog> modality.
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  listTeams.mockReset();
  createTeam.mockReset();
  joinTeam.mockReset();
  leaveTeam.mockReset();
  push.mockReset();
  useMyTeamsStore.getState().reset();
  // A deployment admin turned teams on (they are off by default).
  useDeploymentSwitchesStore.setState({ teams: true, loaded: true });
});
afterEach(cleanup);

describe("TeamsPage while teams are off (the default)", () => {
  it("says so, and offers no New team", async () => {
    useDeploymentSwitchesStore.setState({ teams: false, loaded: true });
    render(<TeamsPage />);
    expect(await screen.findByText("Teams are off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New team/ })).toBeNull();
  });
});

describe("TeamsPage", () => {
  it("lists every team with its size, join policy and the viewer's standing", async () => {
    listTeams.mockResolvedValue({
      teams: [
        team({ id: T1, name: "Platform", memberCount: 3, joinPolicy: "open" }),
        team({
          id: T2,
          name: "Mobile",
          memberCount: 1,
          joinPolicy: "request",
          myRole: "admin",
          myStatus: "active",
          canManage: true,
          pendingCount: 2,
        }),
      ],
    });
    render(<TeamsPage />);

    expect(await screen.findByRole("link", { name: "Platform" })).toHaveAttribute(
      "href",
      `/teams/${T1}`,
    );
    expect(screen.getByText("3 members")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    // The team the viewer runs: their standing, the requests waiting, and Leave.
    expect(screen.getByRole("link", { name: "Mobile" })).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("By request")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 requests" })).toHaveAttribute(
      "href",
      `/teams/${T2}`,
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
    // An open team the viewer isn't in: Join.
    expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
  });

  it("Join asks the API and reloads the list", async () => {
    listTeams.mockResolvedValueOnce({ teams: [team({ joinPolicy: "open" })] }).mockResolvedValue({
      teams: [team({ joinPolicy: "open", myRole: "member", myStatus: "active" })],
    });
    joinTeam.mockResolvedValue({ team: team({ myRole: "member", myStatus: "active" }) });
    render(<TeamsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    await waitFor(() => expect(joinTeam).toHaveBeenCalledWith(T1));
    expect(await screen.findByRole("button", { name: "Leave" })).toBeInTheDocument();
    expect(screen.getByText("Member")).toBeInTheDocument();
  });

  it("a team by request offers Request to join, and a pending one Cancel request", async () => {
    listTeams.mockResolvedValue({
      teams: [
        team({ id: T1, name: "Platform", joinPolicy: "request" }),
        team({ id: T2, name: "Mobile", joinPolicy: "request", myStatus: "requested" }),
        team({ id: "33333333-4444-4555-8666-777777777777", name: "Ops", joinPolicy: "closed" }),
      ],
    });
    leaveTeam.mockResolvedValue(undefined);
    render(<TeamsPage />);

    expect(await screen.findByRole("button", { name: "Request to join" })).toBeInTheDocument();
    expect(screen.getByText("Requested")).toBeInTheDocument();
    expect(screen.getByText("An admin adds members")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(leaveTeam).toHaveBeenCalledWith(T2));
  });

  it("the New team dialog posts the name, description and join policy, then opens the team", async () => {
    listTeams.mockResolvedValue({ teams: [] });
    createTeam.mockResolvedValue({
      team: {
        ...team({ id: T2, name: "Infra", myRole: "admin", myStatus: "active" }),
        members: [],
      },
    });
    render(<TeamsPage />);

    expect(await screen.findByText("No teams yet")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "New team" })[0]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Infra" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The infra folks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));

    await waitFor(() =>
      expect(createTeam).toHaveBeenCalledWith({
        name: "Infra",
        description: "The infra folks",
        joinPolicy: "open",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/teams/${T2}`));
  });
});
